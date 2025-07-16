/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream             from "node:stream"

/*  external dependencies  */
import { RealTimeVAD }    from "@ericedouard/vad-node-realtime"
import { Duration }       from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  audio stream queue element */
type AudioQueueElement =
    { type: "audio-frame", chunk: SpeechFlowChunk, isSpeech?: boolean }

/*  SpeechFlow node for VAD speech-to-speech processing  */
export default class SpeechFlowNodeVAD extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "vad"

    /*  internal state  */
    private vad: RealTimeVAD | null = null
    private queue     = new utils.Queue<AudioQueueElement>()
    private queueRecv = this.queue.pointerUse("recv")
    private queueVAD  = this.queue.pointerUse("vad")
    private queueSend = this.queue.pointerUse("send")

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            mode:               { type: "string", val: "unplugged", match: /^(?:silenced|unplugged)$/ },
            posSpeechThreshold: { type: "number", val: 0.50 },
            negSpeechThreshold: { type: "number", val: 0.35 },
            minSpeechFrames:    { type: "number", val: 4    }, /* (= 128ms: 4 x 512 frameSamples) */
            redemptionFrames:   { type: "number", val: 8    }, /* (= 256ms: 8 x 512 frameSamples) */
            preSpeechPadFrames: { type: "number", val: 1    }  /* (= 32ms:  1 x 512 frameSamples) */
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("VAD node currently supports PCM-S16LE audio only")

        /*  pass-through logging  */
        const log = (level: string, msg: string) => { this.log(level, msg) }

        /*  internal processing constants  */
        const vadSampleRateTarget = 16000 /* internal target of VAD */
        const vadSamplesPerFrame  = 512   /* required for VAD v5 */

        /*  Voice Activity Detection (VAD)  */
        this.vad = await RealTimeVAD.new({
            onSpeechStart: () => {
                log("info", "VAD: speech start")
            },
            onSpeechEnd: (audio) => {
                log("info", `VAD: speech end (samples: ${audio.length})`)
            },
            onVADMisfire: () => {
                log("info", "VAD: speech end (segment too short)")
            },
            onFrameProcessed: (audio) => {
                const element = this.queueVAD.peek()
                const isSpeech = audio.isSpeech > audio.notSpeech
                element.isSpeech = isSpeech
                this.queueVAD.touch()
                this.queueVAD.walk(+1)
            },
            model:                   "v5",
            sampleRate:              this.config.audioSampleRate, /* before resampling to 16KHz */
            frameSamples:            vadSamplesPerFrame,          /* after  resampling to 16KHz */
            positiveSpeechThreshold: this.params.posSpeechThreshold,
            negativeSpeechThreshold: this.params.negSpeechThreshold,
            minSpeechFrames:         this.params.minSpeechFrames,
            redemptionFrames:        this.params.redemptionFrames,
            preSpeechPadFrames:      this.params.preSpeechPadFrames
        })
        this.vad.start()

        /*  helper function: convert Buffer in PCM/I16 to Float32Array in PCM/F32 format  */
        const convertBufToF32 = (buf: Buffer) => {
            const dataView = new DataView(buf.buffer)
            const arr = new Float32Array(buf.length / 2)
            for (let i = 0; i < arr.length; i++)
                arr[i] = dataView.getInt16(i * 2, cfg.audioLittleEndian) / 32768
            return arr
        }

        /*  helper function: convert Float32Array in PCM/F32 to Buffer in PCM/I16 format  */
        const convertF32ToBuf = (arr: Float32Array) => {
            const int16Array = new Int16Array(arr.length)
            for (let i = 0; i < arr.length; i++)
                int16Array[i] = Math.max(-32768, Math.min(32767, Math.round(arr[i] * 32768)))
            return Buffer.from(int16Array.buffer)
        }

        /*  provide Duplex stream and internally attach to VAD  */
        const vad       = this.vad
        const cfg       = this.config
        const queue     = this.queue
        const queueRecv = this.queueRecv
        const queueSend = this.queueSend
        const mode      = this.params.mode
        let carrySamples = new Float32Array()
        let carryStart   = Duration.fromDurationLike(0)
        let endOfStream = false
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,

            /*  receive audio samples  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16 to PCM/F32  */
                    let data = convertBufToF32(chunk.payload)
                    let start = chunk.timestampStart

                    /*  merge previous carry samples  */
                    if (carrySamples.length > 0) {
                        start = carryStart
                        const merged = new Float32Array(carrySamples.length + data.length)
                        merged.set(carrySamples)
                        merged.set(data, carrySamples.length)
                        data = merged
                        carrySamples = new Float32Array()
                    }

                    /*  queue audio samples as individual VAD-sized frames
                        and in parallel send it into the Voice Activity Detection (VAD)  */
                    const chunkSize = (vadSamplesPerFrame * (cfg.audioSampleRate / vadSampleRateTarget))
                    const chunks = Math.trunc(data.length / chunkSize)
                    for (let i = 0; i < chunks; i++) {
                        const frame = data.slice(i * chunkSize, (i + 1) * chunkSize)
                        const buf = convertF32ToBuf(frame)
                        const duration = utils.audioBufferDuration(buf)
                        const end = start.plus(duration)
                        const chunk = new SpeechFlowChunk(start, end, "final", "audio", buf)
                        queueRecv.append({ type: "audio-frame", chunk })
                        vad.processAudio(frame)
                        start = end
                    }

                    /*  remember new carry samples  */
                    const bulkLen = chunks * chunkSize
                    carrySamples = data.slice(bulkLen)
                    carryStart = start

                    callback()
                }
            },

            /*  send transcription texts  */
            read (size) {
                if (endOfStream)
                    this.push(null)
                else {
                    const flushFrames = () => {
                        while (true) {
                            const element = queueSend.peek()
                            if (element === undefined || element.isSpeech === undefined)
                                break
                            if (element.isSpeech)
                                this.push(element.chunk)
                            else if (mode === "silenced") {
                                const chunk = element.chunk.clone()
                                const buffer = chunk.payload as Buffer
                                buffer.fill(0)
                                this.push(chunk)
                            }
                            queueSend.walk(+1)
                        }
                    }
                    const element = queueSend.peek()
                    if (element !== undefined && element.isSpeech !== undefined)
                        flushFrames()
                    else {
                        const flushOnWrite = () => {
                            const element = queueSend.peek()
                            if (element !== undefined && element.isSpeech !== undefined)
                                flushFrames()
                            else
                                queue.once("write", flushOnWrite)
                        }
                        queue.once("write", flushOnWrite)
                    }
                }
            },

            /*  react on end of input  */
            final (callback) {
                if (carrySamples.length > 0) {
                    /*  flush pending audio samples  */
                    const chunkSize = (vadSamplesPerFrame * (cfg.audioSampleRate / vadSampleRateTarget))
                    if (carrySamples.length < chunkSize) {
                        const merged = new Float32Array(chunkSize)
                        merged.set(carrySamples)
                        merged.fill(0.0, carrySamples.length, chunkSize)
                        carrySamples = merged
                    }
                    const buf = convertF32ToBuf(carrySamples)
                    const duration = utils.audioBufferDuration(buf)
                    const end = carryStart.plus(duration)
                    const chunk = new SpeechFlowChunk(carryStart, end, "final", "audio", buf)
                    queueRecv.append({ type: "audio-frame", chunk })
                    vad.processAudio(carrySamples)

                    /*  give the processing a chance to still process the remaining samples  */
                    setTimeout(() => {
                        endOfStream = true
                        this.push(null)
                        callback()
                    }, 2000)
                }
                else {
                    endOfStream = true
                    this.push(null)
                    callback()
                }
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  close VAD  */
        if (this.vad !== null) {
            await this.vad.flush()
            this.vad.destroy()
            this.vad = null
        }
    }
}
