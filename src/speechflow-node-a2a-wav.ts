/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  write WAV header  */
const writeWavHeader = (
    length: number,
    options?: { audioFormat?: number, channels?: number, sampleRate?: number, bitDepth?: number }
) => {
    const audioFormat  = options?.audioFormat ?? 0x001 /* PCM */
    const channels     = options?.channels    ?? 1     /* mono */
    const sampleRate   = options?.sampleRate  ?? 44100 /* 44KHz */
    const bitDepth     = options?.bitDepth    ?? 16    /* 16-Bit */

    const headerLength = 44
    const dataLength   = length || (4294967295 - 100)
    const fileSize     = dataLength + headerLength
    const header       = Buffer.alloc(headerLength)

    const RIFF         = Buffer.alloc(4, "RIFF")
    const WAVE         = Buffer.alloc(4, "WAVE")
    const fmt          = Buffer.alloc(4, "fmt ")
    const data         = Buffer.alloc(4, "data")
    const byteRate     = (sampleRate * channels * bitDepth) / 8
    const blockAlign   = (channels * bitDepth) / 8

    let offset = 0
    RIFF.copy(header, offset);                  offset += RIFF.length
    header.writeUInt32LE(fileSize - 8, offset); offset += 4
    WAVE.copy(header, offset);                  offset += WAVE.length
    fmt.copy(header, offset);                   offset += fmt.length
    header.writeUInt32LE(16, offset);           offset += 4
    header.writeUInt16LE(audioFormat, offset);  offset += 2
    header.writeUInt16LE(channels, offset);     offset += 2
    header.writeUInt32LE(sampleRate, offset);   offset += 4
    header.writeUInt32LE(byteRate, offset);     offset += 4
    header.writeUInt16LE(blockAlign, offset);   offset += 2
    header.writeUInt16LE(bitDepth, offset);     offset += 2
    data.copy(header, offset);                  offset += data.length
    header.writeUInt32LE(dataLength, offset);   offset += 4

    return header
}

/*  read WAV header  */
const readWavHeader = (buffer: Buffer) => {
    let offset = 0
    const riffHead     = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const fileSize     = buffer.readUInt32LE(offset);                    offset += 4
    const waveHead     = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const fmtHead      = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const formatLength = buffer.readUInt32LE(offset);                    offset += 4
    const audioFormat  = buffer.readUInt16LE(offset);                    offset += 2
    const channels     = buffer.readUInt16LE(offset);                    offset += 2
    const sampleRate   = buffer.readUInt32LE(offset);                    offset += 4
    const byteRate     = buffer.readUInt32LE(offset);                    offset += 4
    const blockAlign   = buffer.readUInt16LE(offset);                    offset += 2
    const bitDepth     = buffer.readUInt16LE(offset);                    offset += 2
    const data         = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const dataLength   = buffer.readUInt32LE(offset);                    offset += 4

    return {
        riffHead, fileSize, waveHead, fmtHead, formatLength, audioFormat,
        channels, sampleRate, byteRate, blockAlign, bitDepth, data, dataLength
    }
}

/*  SpeechFlow node for WAV format conversion  */
export default class SpeechFlowNodeWAV extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "wav"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            mode: { type: "string", pos: 1, val: "encode", match: /^(?:encode|decode)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  establish a transform stream  */
        const self = this
        let firstChunk = true
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (firstChunk) {
                    if (self.params.mode === "encode") {
                        /*  convert raw/PCM to WAV/PCM
                            (NOTICE: as this is a continuous stream, the
                            resulting WAV header is not 100% conforming
                            to the WAV standard, as it has to use a zero
                            duration information. This cannot be changed in
                            a stream-based processing.)  */
                        const headerBuffer = writeWavHeader(0, {
                            audioFormat: 0x0001 /* PCM */,
                            channels:    self.config.audioChannels,
                            sampleRate:  self.config.audioSampleRate,
                            bitDepth:    self.config.audioBitDepth
                        })
                        const headerChunk = chunk.clone()
                        headerChunk.payload = headerBuffer
                        this.push(headerChunk)
                        this.push(chunk)
                        callback()
                    }
                    else if (self.params.mode === "decode") {
                        /*  convert WAV/PCM to raw/PCM  */
                        const header = readWavHeader(chunk.payload)
                        self.log("info", "WAV audio stream: " +
                            `audioFormat=${header.audioFormat === 0x0001 ? "PCM" :
                                "0x" + (header.audioFormat as number).toString(16).padStart(4, "0")} ` +
                            `channels=${header.channels} ` +
                            `sampleRate=${header.sampleRate} ` +
                            `bitDepth=${header.bitDepth}`)
                        if (header.audioFormat !== 0x0001 /* PCM */)
                            throw new Error("WAV not based on PCM format")
                        if (header.bitDepth !== 16)
                            throw new Error("WAV not based on 16 bit samples")
                        if (header.sampleRate !== 48000)
                            throw new Error("WAV not based on 48Khz sample rate")
                        if (header.channels !== 1)
                            throw new Error("WAV not based on mono channel")
                        chunk.payload = chunk.payload.subarray(44)
                        this.push(chunk)
                        callback()
                    }
                    else
                        throw new Error(`invalid operation mode "${self.params.mode}"`)
                }
                else {
                    /*  pass-through original chunk  */
                    this.push(chunk)
                    callback()
                }
                firstChunk = false
            },
            final (callback) {
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await new Promise<void>((resolve) => {
                if (this.stream instanceof Stream.Duplex)
                    this.stream.end(() => { resolve() })
                else
                    resolve()
            })
            this.stream.destroy()
            this.stream = null
        }
    }
}

