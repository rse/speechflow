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
type AudioQueueElement = {
    type:      "audio-frame",
    chunk:     SpeechFlowChunk,
    isSpeech?: boolean
} | {
    type:      "audio-eof"
}

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
            minSpeechFrames:    { type: "number", val: 2    },
            redemptionFrames:   { type: "number", val: 12   },
            preSpeechPadFrames: { type: "number", val: 1    }
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

        /*  establish Voice Activity Detection (VAD) facility  */
        this.vad = await RealTimeVAD.new({
            model:                   "v5",
            sampleRate:              this.config.audioSampleRate, /* before resampling to 16KHz */
            frameSamples:            vadSamplesPerFrame,          /* after  resampling to 16KHz */
            positiveSpeechThreshold: this.params.posSpeechThreshold,
            negativeSpeechThreshold: this.params.negSpeechThreshold,
            minSpeechFrames:         this.params.minSpeechFrames,
            redemptionFrames:        this.params.redemptionFrames,
            preSpeechPadFrames:      this.params.preSpeechPadFrames,
            onSpeechStart: () => {
                log("info", "VAD: speech start")
            },
            onSpeechEnd: (audio) => {
                const duration = utils.audioArrayDuration(audio, vadSampleRateTarget)
                log("info", `VAD: speech end (duration: ${duration.toFixed(2)}s)`)
            },
            onVADMisfire: () => {
                log("info", "VAD: speech end (segment too short)")
            },
            onFrameProcessed: (audio) => {
                /*  annotate the current audio frame  */
                const element = this.queueVAD.peek()
                if (element !== undefined && element.type === "audio-frame") {
                    const isSpeech = audio.isSpeech > audio.notSpeech
                    element.isSpeech = isSpeech
                    this.queueVAD.touch()
                    this.queueVAD.walk(+1)
                }
            }
        })
        this.vad.start()

        /*  provide Duplex stream and internally attach to VAD  */
        const vad       = this.vad
        const cfg       = this.config
        const queue     = this.queue
        const queueRecv = this.queueRecv
        const queueSend = this.queueSend
        const mode      = this.params.mode
        let carrySamples = new Float32Array()
        let carryStart   = Duration.fromDurationLike(0)
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,

            /*  receive audio chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16 to PCM/F32  */
                    let data = utils.convertBufToF32(chunk.payload, cfg.audioLittleEndian)
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
                        const buf = utils.convertF32ToBuf(frame)
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

            /*  receive no more audio chunks (writable side of stream)  */
            final (callback) {
                /*  flush pending audio chunks  */
                if (carrySamples.length > 0) {
                    const chunkSize = (vadSamplesPerFrame * (cfg.audioSampleRate / vadSampleRateTarget))
                    if (carrySamples.length < chunkSize) {
                        const merged = new Float32Array(chunkSize)
                        merged.set(carrySamples)
                        merged.fill(0.0, carrySamples.length, chunkSize)
                        carrySamples = merged
                    }
                    const buf = utils.convertF32ToBuf(carrySamples)
                    const duration = utils.audioBufferDuration(buf)
                    const end = carryStart.plus(duration)
                    const chunk = new SpeechFlowChunk(carryStart, end, "final", "audio", buf)
                    queueRecv.append({ type: "audio-frame", chunk })
                    vad.processAudio(carrySamples)
                }

                /*  signal end of file  */
                queueRecv.append({ type: "audio-eof" })
                callback()
            },

            /*  send audio chunk(s) (readable side of stream)  */
            read (_size) {
                /*  try to perform read operation from scratch  */
                const tryToRead = () => {
                    /*  flush pending audio chunks  */
                    const flushPendingChunks = () => {
                        let pushed = 0
                        while (true) {
                            const element = queueSend.peek()
                            if (element === undefined)
                                break
                            else if (element.type === "audio-eof") {
                                this.push(null)
                                break
                            }
                            else if (element.type === "audio-frame"
                                && element.isSpeech === undefined)
                                break
                            queueSend.walk(+1)
                            if (element.isSpeech) {
                                this.push(element.chunk)
                                pushed++
                            }
                            else if (mode === "silenced") {
                                const chunk = element.chunk.clone()
                                const buffer = chunk.payload as Buffer
                                buffer.fill(0)
                                this.push(chunk)
                                pushed++
                            }
                            else if (mode === "unplugged" && pushed === 0)
                                /*  we have to await chunks now, as in unplugged
                                    mode we else would be never called again until
                                    we at least once push a new chunk as the result  */
                                tryToRead()
                        }
                    }

                    /*  await forthcoming audio chunks  */
                    const awaitForthcomingChunks = () => {
                        const element = queueSend.peek()
                        if (element !== undefined
                            && element.type === "audio-frame"
                            && element.isSpeech !== undefined)
                            flushPendingChunks()
                        else
                            queue.once("write", awaitForthcomingChunks)
                    }

                    const element = queueSend.peek()
                    if (element !== undefined && element.type === "audio-eof")
                        this.push(null)
                    else if (element !== undefined
                        && element.type === "audio-frame"
                        && element.isSpeech !== undefined)
                        flushPendingChunks()
                    else
                        queue.once("write", awaitForthcomingChunks)
                }
                tryToRead()
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
