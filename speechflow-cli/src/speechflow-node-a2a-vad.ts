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
import * as util                           from "./speechflow-util"

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
export default class SpeechFlowNodeA2AVAD extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-vad"

    /*  internal state  */
    private vad: RealTimeVAD | null = null
    private queue     = new util.Queue<AudioQueueElement>()
    private queueRecv = this.queue.pointerUse("recv")
    private queueVAD  = this.queue.pointerUse("vad")
    private queueSend = this.queue.pointerUse("send")
    private closing = false
    private tailTimer: ReturnType<typeof setTimeout> | null = null
    private activeEventListeners = new Set<() => void>()

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

        /*  clear destruction flag  */
        this.closing = false

        /*  internal processing constants  */
        const vadSampleRateTarget = 16000 /* internal target of VAD */
        const vadSamplesPerFrame  = 512   /* required for VAD v5 */

        /*  helper function for timer cleanup  */
        const clearTailTimer = () => {
            if (this.tailTimer !== null) {
                clearTimeout(this.tailTimer)
                this.tailTimer = null
            }
        }

        /*  helper function for tail timer handling  */
        let tail = false
        const startTailTimer = () => {
            tail = true
            clearTailTimer()
            this.tailTimer = setTimeout(() => {
                if (this.closing || this.tailTimer === null)
                    return
                tail = false
                this.tailTimer = null
            }, this.params.postSpeechTail)
        }

        /*  establish Voice Activity Detection (VAD) facility  */
        try {
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
                    if (this.closing)
                        return
                    this.log("info", "VAD: speech start")
                    if (this.params.mode === "unplugged") {
                        tail = false
                        clearTailTimer()
                    }
                },
                onSpeechEnd: (audio) => {
                    if (this.closing)
                        return
                    const duration = util.audioArrayDuration(audio, vadSampleRateTarget)
                    this.log("info", `VAD: speech end (duration: ${duration.toFixed(2)}s)`)
                    if (this.params.mode === "unplugged")
                        startTailTimer()
                },
                onVADMisfire: () => {
                    if (this.closing)
                        return
                    this.log("info", "VAD: speech end (segment too short)")
                    if (this.params.mode === "unplugged")
                        startTailTimer()
                },
                onFrameProcessed: (audio) => {
                    if (this.closing)
                        return
                    try {
                        /*  annotate the current audio segment  */
                        const element = this.queueVAD.peek()
                        if (element === undefined || element.type !== "audio-frame")
                            throw new Error("internal error that cannot happen: no more queued element")
                        if (element.segmentIdx >= element.segmentData.length)
                            throw new Error("segment index out of bounds")
                        const segment = element.segmentData[element.segmentIdx++]
                        segment.isSpeech = (audio.isSpeech > audio.notSpeech) || tail

                        /*  annotate the entire audio chunk  */
                        if (element.segmentIdx >= element.segmentData.length) {
                            element.isSpeech = element.segmentData.some(segment => segment.isSpeech)
                            this.queueVAD.touch()
                            this.queueVAD.walk(+1)
                        }
                    }
                    catch (error) {
                        this.log("error", `VAD frame processing error: ${error}`, { cause: error })
                    }
                }
            })
            this.vad.start()
        }
        catch (error) {
            throw new Error(`failed to initialize VAD: ${error}`, { cause: error })
        }

        /*  provide Duplex stream and internally attach to VAD  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  receive audio chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    try {
                        /*  convert audio samples from PCM/I16 to PCM/F32  */
                        const data = util.convertBufToF32(chunk.payload,
                            self.config.audioLittleEndian)

                        /*  segment audio samples as individual VAD-sized frames  */
                        const segmentData: AudioQueueElementSegment[] = []
                        const chunkSize = vadSamplesPerFrame *
                            (self.config.audioSampleRate / vadSampleRateTarget)
                        const chunks = Math.trunc(data.length / chunkSize)
                        for (let i = 0; i < chunks; i++) {
                            const frame = data.slice(i * chunkSize, (i + 1) * chunkSize)
                            const segment: AudioQueueElementSegment = { data: frame }
                            segmentData.push(segment)
                        }
                        if ((chunks * chunkSize) < data.length) {
                            const frame = new Float32Array(chunkSize)
                            frame.fill(0)
                            frame.set(data.slice(chunks * chunkSize))
                            const segment: AudioQueueElementSegment = { data: frame }
                            segmentData.push(segment)
                        }

                        /*  queue the results  */
                        self.queueRecv.append({
                            type: "audio-frame", chunk,
                            segmentIdx: 0, segmentData
                        })

                        /*  push segments through Voice Activity Detection (VAD)  */
                        if (self.vad && !self.closing) {
                            try {
                                for (const segment of segmentData)
                                    self.vad.processAudio(segment.data)
                            }
                            catch (error) {
                                self.log("error", `VAD processAudio error: ${error}`)
                            }
                        }

                        /*  signal completion  */
                        callback()
                    }
                    catch (error) {
                        callback(util.ensureError(error, "VAD processing failed"))
                    }
                }
            },

            /*  receive no more audio chunks (writable side of stream)  */
            final (callback) {
                if (self.closing) {
                    callback()
                    return
                }

                /*  signal end of file  */
                self.queueRecv.append({ type: "audio-eof" })
                callback()
            },

            /*  send audio chunk(s) (readable side of stream)  */
            read (_size) {
                if (self.closing) {
                    this.push(null)
                    return
                }

                /*  try to perform read operation from scratch  */
                const tryToRead = () => {
                    if (self.closing) {
                        this.push(null)
                        return
                    }

                    /*  flush pending audio chunks  */
                    const flushPendingChunks = () => {
                        let pushed = 0
                        while (true) {
                            if (self.closing) {
                                this.push(null)
                                return
                            }
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
                            else if (self.params.mode === "unplugged" && pushed === 0) {
                                /*  we have to await chunks now, as in unplugged
                                    mode we else would be never called again until
                                    we at least once push a new chunk as the result  */
                                setTimeout(() => {
                                    if (self.closing || self.queue === null)
                                        return
                                    tryToRead()
                                }, 0)
                                return
                            }
                        }
                    }

                    /*  await forthcoming audio chunks  */
                    const awaitForthcomingChunks = () => {
                        self.activeEventListeners.delete(awaitForthcomingChunks)
                        if (self.closing)
                            return
                        const element = self.queueSend.peek()
                        if (element !== undefined
                            && element.type === "audio-frame"
                            && element.isSpeech !== undefined)
                            flushPendingChunks()
                        else if (!self.closing && !self.activeEventListeners.has(awaitForthcomingChunks)) {
                            self.queue.once("write", awaitForthcomingChunks)
                            self.activeEventListeners.add(awaitForthcomingChunks)
                        }
                    }

                    /*  peek at send queue element  */
                    const element = self.queueSend.peek()
                    if (element !== undefined && element.type === "audio-eof")
                        this.push(null)
                    else if (element !== undefined
                        && element.type === "audio-frame"
                        && element.isSpeech !== undefined)
                        flushPendingChunks()
                    else if (!self.closing && !self.activeEventListeners.has(awaitForthcomingChunks)) {
                        self.queue.once("write", awaitForthcomingChunks)
                        self.activeEventListeners.add(awaitForthcomingChunks)
                    }
                }
                tryToRead()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  cleanup tail timer  */
        if (this.tailTimer !== null) {
            clearTimeout(this.tailTimer)
            this.tailTimer = null
        }

        /*  remove all event listeners  */
        this.activeEventListeners.forEach((listener) => {
            this.queue.removeListener("write", listener)
        })
        this.activeEventListeners.clear()

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  cleanup queue pointers before closing VAD to prevent callback access  */
        this.queue.pointerDelete("recv")
        this.queue.pointerDelete("vad")
        this.queue.pointerDelete("send")

        /*  close VAD  */
        if (this.vad !== null) {
            try {
                const flushPromise = this.vad.flush()
                const timeoutPromise = new Promise((resolve) => { setTimeout(resolve, 5000) })
                await Promise.race([ flushPromise, timeoutPromise ])
            }
            catch (error) {
                this.log("warning", `VAD flush error during close: ${error}`)
            }
            this.vad.destroy()
            this.vad = null
        }
    }
}
