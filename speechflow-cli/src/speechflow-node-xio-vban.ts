/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { DateTime }                        from "luxon"
import { VBANServer, VBANAudioPacket,
         EBitsResolutions, ECodecs }       from "vban"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  VBAN sample rate index to Hz mapping  */
const sampleRateToIndex: { [ rate: number ]: number } = {
    6000:   0,  12000:  1,  24000:  2,  48000:  3,  96000:  4,  192000: 5,  384000: 6,
    8000:   7,  16000:  8,  32000:  9,  64000:  10, 128000: 11, 256000: 12, 512000: 13,
    11025:  14, 22050:  15, 44100:  16, 88200:  17, 176400: 18, 352800: 19, 705600: 20
}

/*  SpeechFlow node for VBAN networking  */
export default class SpeechFlowNodeXIOVBAN extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-vban"

    /*  internal state  */
    private server:        VBANServer                        | null = null
    private chunkQueue:    util.SingleQueue<SpeechFlowChunk> | null = null
    private frameCounter                                            = 0
    private targetAddress                                           = ""
    private targetPort                                              = 0

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            listen:  { type: "string", pos: 0, val: "",       match: /^(?:|\d+|.+?:\d+)$/ },
            connect: { type: "string", pos: 1, val: "",       match: /^(?:|.+?:\d+)$/ },
            stream:  { type: "string", pos: 2, val: "Stream", match: /^.{1,16}$/ },
            mode:    { type: "string", pos: 3, val: "rw",     match: /^(?:r|w|rw)$/ }
        })

        /*  sanity check parameters  */
        if (this.params.listen === "" && this.params.connect === "")
            throw new Error("VBAN node requires either listen or connect mode")
        if (this.params.mode === "r" && this.params.listen === "")
            throw new Error("VBAN read mode requires a listen address")
        if (this.params.mode === "w" && this.params.connect === "")
            throw new Error("VBAN write mode requires a connect address")

        /*  VBAN only handles audio  */
        if (this.params.mode === "rw") {
            this.input  = "audio"
            this.output = "audio"
        }
        else if (this.params.mode === "r") {
            this.input  = "none"
            this.output = "audio"
        }
        else if (this.params.mode === "w") {
            this.input  = "audio"
            this.output = "none"
        }
    }

    /*  parse address:port string  */
    private parseAddress (addr: string, defaultPort: number): { host: string, port: number } {
        if (addr.match(/^\d+$/))
            return { host: "0.0.0.0", port: Number.parseInt(addr, 10) }
        const m = addr.match(/^(.+?):(\d+)$/)
        if (m === null)
            return { host: addr, port: defaultPort }
        return { host: m[1], port: Number.parseInt(m[2], 10) }
    }

    /*  open node  */
    async open () {
        /*  create VBAN server  */
        this.server = new VBANServer({
            application: {
                applicationName:  "SpeechFlow",
                manufacturerName: "Dr. Ralf S. Engelschall",
                deviceName:       this.id
            }
        })

        /*  setup error handling  */
        this.server.on("error", (err: Error) => {
            this.log("error", `VBAN error: ${err.message}`)
        })

        /*  setup chunk queue for incoming audio  */
        this.chunkQueue = new util.SingleQueue<SpeechFlowChunk>()

        /*  determine target for sending  */
        if (this.params.connect !== "") {
            const target = this.parseAddress(this.params.connect, 6980)
            this.targetAddress = target.host
            this.targetPort    = target.port
        }

        /*  handle incoming VBAN packets  */
        this.server.on("message", (packet: any, sender: { address: string, port: number }) => {
            if (this.params.mode === "w")
                return

            /*  only handle audio packets  */
            if (!(packet instanceof VBANAudioPacket))
                return

            /*  optionally filter by stream name  */
            if (this.params.stream !== "" && packet.streamName !== this.params.stream)
                return

            /*  get audio data from packet  */
            if (!Buffer.isBuffer(packet.data)) {
                this.log("warning", "VBAN packet data is not a Buffer")
                return
            }
            const data = packet.data

            /*  convert audio format if necessary  */
            let audioBuffer: Buffer
            const bitResolution = packet.bitResolution
            if (bitResolution === EBitsResolutions.VBAN_DATATYPE_INT16) {
                /*  16-bit signed integer - matches our format  */
                audioBuffer = data
            }
            else if (bitResolution === EBitsResolutions.VBAN_DATATYPE_BYTE8) {
                /*  8-bit unsigned to 16-bit signed  */
                audioBuffer = Buffer.alloc(data.length * 2)
                for (let i = 0; i < data.length; i++) {
                    const sample = ((data[i] - 128) / 128) * 32767
                    audioBuffer.writeInt16LE(Math.round(sample), i * 2)
                }
            }
            else if (bitResolution === EBitsResolutions.VBAN_DATATYPE_INT24) {
                /*  24-bit signed to 16-bit signed  */
                const samples = Math.floor(data.length / 3)
                audioBuffer = Buffer.alloc(samples * 2)
                for (let i = 0; i < samples; i++) {
                    const b0 = data[i * 3]
                    const b1 = data[i * 3 + 1]
                    const b2 = data[i * 3 + 2]
                    const value = ((b2 << 16) | (b1 << 8) | b0) & 0xFFFFFF
                    const signed = value > 0x7FFFFF ? value - 0x1000000 : value
                    const sample = (signed / 0x800000) * 32767
                    audioBuffer.writeInt16LE(Math.round(sample), i * 2)
                }
            }
            else if (bitResolution === EBitsResolutions.VBAN_DATATYPE_INT32) {
                /*  32-bit signed to 16-bit signed  */
                const samples = Math.floor(data.length / 4)
                audioBuffer = Buffer.alloc(samples * 2)
                for (let i = 0; i < samples; i++) {
                    const value = data.readInt32LE(i * 4)
                    const sample = (value / 0x80000000) * 32767
                    audioBuffer.writeInt16LE(Math.round(sample), i * 2)
                }
            }
            else if (bitResolution === EBitsResolutions.VBAN_DATATYPE_FLOAT32) {
                /*  32-bit float to 16-bit signed  */
                const samples = Math.floor(data.length / 4)
                audioBuffer = Buffer.alloc(samples * 2)
                for (let i = 0; i < samples; i++) {
                    const value = data.readFloatLE(i * 4)
                    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
                    audioBuffer.writeInt16LE(sample, i * 2)
                }
            }
            else if (bitResolution === EBitsResolutions.VBAN_DATATYPE_FLOAT64) {
                /*  64-bit float to 16-bit signed  */
                const samples = Math.floor(data.length / 8)
                audioBuffer = Buffer.alloc(samples * 2)
                for (let i = 0; i < samples; i++) {
                    const value = data.readDoubleLE(i * 8)
                    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
                    audioBuffer.writeInt16LE(sample, i * 2)
                }
            }
            else {
                /*  unsupported format  */
                this.log("warning", `unsupported VBAN bit resolution: ${bitResolution}`)
                return
            }

            /*  handle channel conversion if needed  */
            const channels = packet.nbChannel + 1
            if (channels > 1 && this.config.audioChannels === 1) {
                /*  downmix to mono  */
                const samples = audioBuffer.length / 2 / channels
                const monoBuffer = Buffer.alloc(samples * 2)
                for (let i = 0; i < samples; i++) {
                    let sum = 0
                    for (let ch = 0; ch < channels; ch++)
                        sum += audioBuffer.readInt16LE((i * channels + ch) * 2)
                    monoBuffer.writeInt16LE(Math.round(sum / channels), i * 2)
                }
                audioBuffer = monoBuffer
            }

            /*  create chunk with timing information  */
            const now = DateTime.now()
            const start = now.diff(this.timeZero)
            const duration = util.audioBufferDuration(audioBuffer,
                this.config.audioSampleRate, this.config.audioBitDepth, this.config.audioChannels)
            const end = start.plus(duration * 1000)
            const chunk = new SpeechFlowChunk(start, end, "final", "audio", audioBuffer)
            this.chunkQueue?.write(chunk)
        })

        /*  setup listening  */
        this.server.on("listening", () => {
            const address = this.server!.address()
            this.log("info", `VBAN listening on ${address.address}:${address.port}`)
        })

        /*  bind to listen port  */
        if (this.params.listen !== "") {
            const listen = this.parseAddress(this.params.listen, 6980)
            this.server.bind(listen.port, listen.host)
        }
        else
            /*  still need to bind for sending  */
            this.server.bind(0)

        /*  create duplex stream  */
        const self = this
        const reads = new util.PromiseSet<void>()
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.params.mode === "r") {
                    callback(new Error("write operation on read-only node"))
                    return
                }
                if (chunk.type !== "audio") {
                    callback(new Error("VBAN only supports audio type"))
                    return
                }
                if (self.targetAddress === "") {
                    callback(new Error("no VBAN target address configured"))
                    return
                }

                /*  get audio buffer  */
                const audioBuffer = chunk.payload as Buffer

                /*  determine VBAN sample rate index  */
                const sampleRateIndex = sampleRateToIndex[self.config.audioSampleRate]
                if (sampleRateIndex === undefined) {
                    callback(new Error(`unsupported sample rate for VBAN: ${self.config.audioSampleRate}`))
                    return
                }

                /*  calculate number of samples  */
                const bytesPerSample = self.config.audioBitDepth / 8
                const nbSample = (audioBuffer.length / bytesPerSample / self.config.audioChannels) - 1
                if (nbSample < 0 || nbSample > 255)
                    self.log("warning", `VBAN nbSample out of range: ${nbSample} (clamped to 0-255)`)

                /*  create VBAN audio packet  */
                const packet = new VBANAudioPacket({
                    streamName:    self.params.stream,
                    srIndex:       sampleRateIndex,
                    nbSample:      Math.min(255, Math.max(0, nbSample)),
                    nbChannel:     self.config.audioChannels - 1,
                    bitResolution: EBitsResolutions.VBAN_DATATYPE_INT16,
                    codec:         ECodecs.VBAN_CODEC_PCM,
                    frameCounter:  self.frameCounter++
                }, audioBuffer)

                /*  send packet  */
                self.server!.send(packet, self.targetPort, self.targetAddress)
                    .then(() => callback())
                    .catch((err: Error) => callback(err))
            },
            async final (callback) {
                await reads.awaitAll()
                callback()
            },
            read (size: number) {
                if (self.params.mode === "w")
                    throw new Error("read operation on write-only node")
                reads.add(self.chunkQueue!.read().then((chunk) => {
                    this.push(chunk, "binary")
                }).catch((err: Error) => {
                    self.log("warning", `read on chunk queue operation failed: ${err}`)
                    this.push(null)
                }))
            }
        })
    }

    /*  close node  */
    async close () {
        /*  drain and clear chunk queue reference  */
        if (this.chunkQueue !== null) {
            this.chunkQueue.drain()
            this.chunkQueue = null
        }

        /*  close VBAN server  */
        if (this.server !== null) {
            this.server.close()
            this.server = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
