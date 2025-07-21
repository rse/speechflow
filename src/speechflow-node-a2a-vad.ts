/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream             from "node:stream"

/*  external dependencies  */
import { RealTimeVAD }    from "@ericedouard/vad-node-realtime"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  audio stream queue element */
type AudioQueueElementSegment = {
    data:        Float32Array,
    isSpeech?:   boolean
}
type AudioQueueElement = {
    type:       "audio-frame",
    chunk:       SpeechFlowChunk,
    segmentIdx:  number,
    segmentData: AudioQueueElementSegment[],
    isSpeech?:   boolean
} | {
    type:        "audio-eof"
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
            mode:               { type: "string", val: "silenced", match: /^(?:silenced|unplugged)$/ },
            posSpeechThreshold: { type: "number", val: 0.50 },
            negSpeechThreshold: { type: "number", val: 0.35 },
            minSpeechFrames:    { type: "number", val: 2    },
            redemptionFrames:   { type: "number", val: 12   },
            preSpeechPadFrames: { type: "number", val: 1    },
            postSpeechTail:     { type: "number", val: 1500 }
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
        let tail = false
        let tailTimer: ReturnType<typeof setTimeout> | null = null
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
                if (this.params.mode === "unlugged") {
                    tail = false
                    if (tailTimer !== null) {
                        clearTimeout(tailTimer)
                        tailTimer = null
                    }
                }
            },
            onSpeechEnd: (audio) => {
                const duration = utils.audioArrayDuration(audio, vadSampleRateTarget)
                log("info", `VAD: speech end (duration: ${duration.toFixed(2)}s)`)
                if (this.params.mode === "unlugged") {
                    tail = true
                    if (tailTimer !== null)
                        clearTimeout(tailTimer)
                    tailTimer = setTimeout(() => {
                        tail = false
                        tailTimer = null
                    }, this.params.postSpeechTail)
                }
            },
            onVADMisfire: () => {
                log("info", "VAD: speech end (segment too short)")
                if (this.params.mode === "unlugged") {
                    tail = true
                    if (tailTimer !== null)
                        clearTimeout(tailTimer)
                    tailTimer = setTimeout(() => {
                        tail = false
                        tailTimer = null
                    }, this.params.postSpeechTail)
                }
            },
            onFrameProcessed: (audio) => {
                /*  annotate the current audio segment  */
                const element = this.queueVAD.peek()
                if (element === undefined || element.type !== "audio-frame")
                    throw new Error("internal error which cannot happen: no more queued element")
                const segment = element.segmentData[element.segmentIdx++]
                segment.isSpeech = (audio.isSpeech > audio.notSpeech) || tail

                /*  annotate the entire audio chunk  */
                if (element.segmentIdx >= element.segmentData.length) {
                    let isSpeech = false
                    for (const segment of element.segmentData) {
                        if (segment.isSpeech) {
                            isSpeech = true
                            break
                        }
                    }
                    element.isSpeech = isSpeech
                    this.queueVAD.touch()
                    this.queueVAD.walk(+1)
                }
            }
        })
        this.vad.start()

        /*  provide Duplex stream and internally attach to VAD  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  receive audio chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16 to PCM/F32  */
                    const data = utils.convertBufToF32(chunk.payload, self.config.audioLittleEndian)

                    /*  segment audio samples as individual VAD-sized frames  */
                    const segmentData: AudioQueueElementSegment[] = []
                    const chunkSize = vadSamplesPerFrame * (self.config.audioSampleRate / vadSampleRateTarget)
                    const chunks = Math.trunc(data.length / chunkSize)
                    for (let i = 0; i < chunks; i++) {
                        const frame = data.slice(i * chunkSize, (i + 1) * chunkSize)
                        const segment: AudioQueueElementSegment = { data: frame }
                        segmentData.push(segment)
                    }
                    if ((chunks * chunkSize) < data.length) {
                        const frame = new Float32Array(chunkSize)
                        frame.fill(0)
                        frame.set(data.slice(chunks * chunkSize, data.length))
                        const segment: AudioQueueElementSegment = { data: frame }
                        segmentData.push(segment)
                    }

                    /*  queue the results  */
                    self.queueRecv.append({
                        type: "audio-frame", chunk,
                        segmentIdx: 0, segmentData
                    })

                    /*  push segments through Voice Activity Detection (VAD)  */
                    for (const segment of segmentData)
                        self.vad!.processAudio(segment.data)

                    callback()
                }
            },

            /*  receive no more audio chunks (writable side of stream)  */
            final (callback) {
                /*  signal end of file  */
                self.queueRecv.append({ type: "audio-eof" })
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
                            const element = self.queueSend.peek()
                            if (element === undefined)
                                break
                            else if (element.type === "audio-eof") {
                                this.push(null)
                                break
                            }
                            else if (element.type === "audio-frame"
                                && element.isSpeech === undefined)
                                break
                            self.queueSend.walk(+1)
                            self.queue.trim()
                            if (element.isSpeech) {
                                this.push(element.chunk)
                                pushed++
                            }
                            else if (self.params.mode === "silenced") {
                                const chunk = element.chunk.clone()
                                const buffer = chunk.payload as Buffer
                                buffer.fill(0)
                                this.push(chunk)
                                pushed++
                            }
                            else if (self.params.mode === "unplugged" && pushed === 0)
                                /*  we have to await chunks now, as in unplugged
                                    mode we else would be never called again until
                                    we at least once push a new chunk as the result  */
                                tryToRead()
                        }
                    }

                    /*  await forthcoming audio chunks  */
                    const awaitForthcomingChunks = () => {
                        const element = self.queueSend.peek()
                        if (element !== undefined
                            && element.type === "audio-frame"
                            && element.isSpeech !== undefined)
                            flushPendingChunks()
                        else
                            self.queue.once("write", awaitForthcomingChunks)
                    }

                    const element = self.queueSend.peek()
                    if (element !== undefined && element.type === "audio-eof")
                        this.push(null)
                    else if (element !== undefined
                        && element.type === "audio-frame"
                        && element.isSpeech !== undefined)
                        flushPendingChunks()
                    else
                        self.queue.once("write", awaitForthcomingChunks)
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
