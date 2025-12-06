/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"
import { EventEmitter } from "node:events"
import { Duration }     from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

class AudioFiller extends EventEmitter {
    private emittedEndSamples = 0           /* stream position in samples already emitted */
    private readonly bytesPerSample = 2     /* PCM I16 */
    private readonly bytesPerFrame: number
    private readonly sampleTolerance = 0.5  /* tolerance for floating-point sample comparisons */

    constructor (private sampleRate = 48000, private channels = 1) {
        super()
        this.bytesPerFrame = this.channels * this.bytesPerSample
    }

    /*  optional helper to allow subscribing with strong typing  */
    public on(event: "chunk", listener: (chunk: SpeechFlowChunk, type: string) => void): this
    public on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener)
    }

    /*  convert fractional samples to duration  */
    private samplesFromDuration(duration: Duration): number {
        const seconds = duration.as("seconds")
        const samples = seconds * this.sampleRate
        return samples
    }

    /*  convert duration to fractional samples  */
    private durationFromSamples(samples: number): Duration {
        const seconds = samples / this.sampleRate
        return Duration.fromObject({ seconds })
    }

    /*  emit a chunk of silence  */
    private emitSilence (fromSamples: number, toSamples: number, meta?: Map<string, any>) {
        const frames = Math.max(0, Math.floor(toSamples - fromSamples))
        if (frames <= 0)
            return
        const payload = Buffer.alloc(frames * this.bytesPerFrame) /* already zeroed */
        const timestampStart = this.durationFromSamples(fromSamples)
        const timestampEnd   = this.durationFromSamples(toSamples)
        const chunk = new SpeechFlowChunk(timestampStart, timestampEnd,
            "final", "audio", payload, meta ? new Map(meta) : undefined)
        this.emit("chunk", chunk, "silence")
    }

    /*  add a chunk of audio for processing  */
    public add (chunk: SpeechFlowChunk & { type: "audio", payload: Buffer }): void {
        const startSamp = this.samplesFromDuration(chunk.timestampStart)
        const endSamp   = this.samplesFromDuration(chunk.timestampEnd)
        if (endSamp < startSamp)
            throw new Error("invalid timestamps")

        /*  if chunk starts beyond what we've emitted, insert silence for the gap  */
        if (startSamp > this.emittedEndSamples + this.sampleTolerance) {
            this.emitSilence(this.emittedEndSamples, startSamp, chunk.meta)
            this.emittedEndSamples = startSamp
        }

        /*  if chunk ends before or at emitted end, we have it fully covered, so drop it  */
        if (endSamp <= this.emittedEndSamples + this.sampleTolerance)
            return

        /*  trim any overlap at the head  */
        const trimHead = Math.max(0, Math.floor(this.emittedEndSamples - startSamp))
        const availableFrames = Math.floor((endSamp - startSamp) - trimHead)
        if (availableFrames <= 0)
            return

        /*  determine how many frames the buffer actually has; trust timestamps primarily  */
        const bufFrames = Math.floor(chunk.payload.length / this.bytesPerFrame)
        const startFrame = Math.min(trimHead, bufFrames)
        const endFrame = Math.min(startFrame + availableFrames, bufFrames)
        if (endFrame <= startFrame)
            return

        /*  determine trimmed/normalized chunk  */
        const payload = chunk.payload.subarray(
            startFrame * this.bytesPerFrame,
            endFrame * this.bytesPerFrame)

        /*  emit trimmed/normalized chunk  */
        const outStartSamples = startSamp + startFrame
        const outEndSamples   = outStartSamples + Math.floor(payload.length / this.bytesPerFrame)
        const timestampStart  = this.durationFromSamples(outStartSamples)
        const timestampEnd    = this.durationFromSamples(outEndSamples)
        const c = new SpeechFlowChunk(timestampStart, timestampEnd,
            "final", "audio", payload, new Map(chunk.meta))
        this.emit("chunk", c, "content")

        /*  advance emitted cursor  */
        this.emittedEndSamples = Math.max(this.emittedEndSamples, outEndSamples)
    }
}

/*  SpeechFlow node for filling audio gaps  */
export default class SpeechFlowNodeA2AFiller extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-filler"

    /*  internal state  */
    private closing = false
    private filler: AudioFiller | null = null
    private sendQueue: util.AsyncQueue<SpeechFlowChunk | null> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            segment: { type: "number", val: 50, pos: 0, match: (n: number) => n >= 10 && n <= 1000 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  establish queues  */
        this.filler  = new AudioFiller(this.config.audioSampleRate, this.config.audioChannels)
        this.sendQueue = new util.AsyncQueue<SpeechFlowChunk | null>()

        /*  shift chunks from filler to send queue  */
        this.filler.on("chunk", (chunk, type) => {
            this.sendQueue?.write(chunk)
        })

        /*  establish a duplex stream  */
        const self = this
        this.stream = new Stream.Duplex({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            write (chunk: SpeechFlowChunk & { type: "audio", payload: Buffer }, encoding, callback) {
                if (self.closing || self.filler === null)
                    callback(new Error("stream already destroyed"))
                else if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    try {
                        if (self.closing || self.filler === null)
                            throw new Error("stream already destroyed")
                        self.filler.add(chunk)
                        callback()
                    }
                    catch (error: unknown) {
                        callback(util.ensureError(error))
                    }
                }
            },
            read (size) {
                if (self.closing || self.sendQueue === null) {
                    this.push(null)
                    return
                }
                self.sendQueue.read().then((chunk) => {
                    if (self.closing || self.sendQueue === null) {
                        this.push(null)
                        return
                    }
                    if (chunk === null) {
                        self.log("info", "received EOF signal")
                        this.push(null)
                    }
                    else if (!(chunk.payload instanceof Buffer)) {
                        self.log("warning", "invalid chunk (expected audio buffer)")
                        this.push(null)
                    }
                    else {
                        self.log("debug", `received data (${chunk.payload.byteLength} bytes)`)
                        this.push(chunk)
                    }
                }).catch((error: unknown) => {
                    if (!self.closing && self.sendQueue !== null)
                        self.log("error", `queue read error: ${util.ensureError(error).message}`)
                })
            },
            final (callback) {
                if (self.closing) {
                    callback()
                    return
                }
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  destroy queues  */
        if (this.sendQueue !== null) {
            this.sendQueue.destroy()
            this.sendQueue = null
        }

        /*  destroy filler  */
        if (this.filler !== null) {
            this.filler.removeAllListeners()
            this.filler = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

