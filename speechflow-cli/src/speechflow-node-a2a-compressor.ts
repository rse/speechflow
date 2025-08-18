/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

// FIXME autogain

/*  standard dependencies  */
import path   from "node:path"
import Stream from "node:stream"

/*  external dependencies  */
import { AudioContext, AudioWorkletNode, GainNode, DynamicsCompressorNode } from "node-web-audio-api"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  internal types  */
interface CompressorConfig {
    threshold?: number
    knee?:      number
    ratio?:     number
    attack?:    number
    release?:   number
}
interface ProcessingResult {
    data: Int16Array
    gainReduction: number
}

/*  audio compressor class  */
class AudioCompressor {
    private audioContext:      AudioContext
    private readonly channels: number
    private compressor!:       DynamicsCompressorNode
    private gainNode!:         GainNode
    private sourceNode!:       AudioWorkletNode
    private captureNode!:      AudioWorkletNode
    private config:            Required<CompressorConfig>
    private isInitialized    = false
    private workletUrl       = ""
    private pendingPromises  = new Map<string, {
        resolve: (value: ProcessingResult) => void
        reject: (error: Error) => void
        timeout: ReturnType<typeof setTimeout>
    }>()

    /*  construct object  */
    constructor(
        sampleRate = 48000,
        channels   = 1,
        compressorConfig: CompressorConfig = {}
    ) {
        this.audioContext = new AudioContext({ sampleRate, latencyHint: "interactive" })
        this.channels = channels
        this.config = {
            threshold: compressorConfig.threshold ?? -24,
            knee:      compressorConfig.knee      ?? 30,
            ratio:     compressorConfig.ratio     ?? 12,
            attack:    compressorConfig.attack    ?? 0.003,
            release:   compressorConfig.release   ?? 0.25
        }
        this.workletUrl = path.resolve(__dirname, "speechflow-node-a2a-compressor-wt.js")
    }

    /*  initialize the object  */
    public async initialize(): Promise<void> {
        if (this.isInitialized)
            return
        try {
            /*  ensure audio context is not suspended  */
            if (this.audioContext.state === "suspended")
                await this.audioContext.resume()

            /*  add audio worklet module  */
            await this.audioContext.audioWorklet.addModule(this.workletUrl)

            /*  create nodes  */
            this.sourceNode = new AudioWorkletNode(this.audioContext, "audio-source-processor", {
                numberOfInputs:  0,
                numberOfOutputs: 1,
                outputChannelCount: [ this.channels ]
            })
            this.gainNode   = this.audioContext.createGain()
            this.compressor = this.audioContext.createDynamicsCompressor()
            this.captureNode = new AudioWorkletNode(this.audioContext, "audio-capture-processor", {
                numberOfInputs:  1,
                numberOfOutputs: 0
            })

            /*  connect nodes  */
            this.sourceNode.connect(this.gainNode)
            this.gainNode.connect(this.compressor)
            this.compressor.connect(this.captureNode)

            /*  configure compressor node  */
            const currentTime = this.audioContext.currentTime
            this.compressor.threshold.setValueAtTime(this.config.threshold, currentTime)
            this.compressor.knee.setValueAtTime(this.config.knee, currentTime)
            this.compressor.ratio.setValueAtTime(this.config.ratio, currentTime)
            this.compressor.attack.setValueAtTime(this.config.attack, currentTime)
            this.compressor.release.setValueAtTime(this.config.release, currentTime)

            /*  setup message handler for capture node  */
            this.captureNode.port.addEventListener("message", (event) => {
                const { type, chunkId, data } = event.data ?? {}
                if (type === "capture-complete") {
                    const promise = this.pendingPromises.get(chunkId)
                    if (promise) {
                        clearTimeout(promise.timeout)
                        this.pendingPromises.delete(chunkId)
                        const int16Data = new Int16Array(data.length)
                        for (let i = 0; i < data.length; i++)
                            int16Data[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)))
                        promise.resolve({
                            data: int16Data,
                            gainReduction: this.compressor.reduction ?? 0
                        })
                    }
                }
            })
            this.captureNode.port.start()

            this.isInitialized = true
        }
        catch (error) {
            throw new Error(`failed to initialize AudioCompressor: ${error}`)
        }
    }
    public async processChunk(int16Array: Int16Array): Promise<ProcessingResult> {
        if (!this.isInitialized)
            await this.initialize()
        const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
        return new Promise<ProcessingResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPromises.delete(chunkId)
                reject(new Error("processing timeout"))
            }, (int16Array.length / this.audioContext.sampleRate) * 1000 + 250)
            this.pendingPromises.set(chunkId, { resolve, reject, timeout })
            try {
                const float32Data = new Float32Array(int16Array.length)
                for (let i = 0; i < int16Array.length; i++)
                    float32Data[i] = int16Array[i] / 32768.0

                /*  start capture first  */
                this.captureNode.port.postMessage({
                    type: "start-capture",
                    chunkId,
                    expectedSamples: int16Array.length
                })

                /*  small delay to ensure capture is ready before sending data  */
                setTimeout(() => {
                    /*  send input to source node  */
                    this.sourceNode.port.postMessage({
                        type: "input-chunk",
                        chunkId,
                        data: { pcmData: float32Data, channels: this.channels }
                    }, [ float32Data.buffer ])
                }, 5)
            }
            catch (error) {
                clearTimeout(timeout)
                this.pendingPromises.delete(chunkId)
                reject(new Error(`failed to process chunk: ${error}`))
            }
        })
    }
    public getGainReduction(): number {
        return this.isInitialized ? (this.compressor.reduction ?? 0) : 0
    }
    public setGain(decibel: number): void {
        if (!this.isInitialized)
            throw new Error("not initialized")
        const gain = Math.pow(10, decibel / 20)
        this.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime)
    }
    public async stop(): Promise<void> {
        if (!this.isInitialized)
            return

        /*  reject all pending promises  */
        try {
            this.pendingPromises.forEach(({ reject, timeout }) => {
                clearTimeout(timeout)
                reject(new Error("compressor stopped"))
            })
            this.pendingPromises.clear()
        }
        catch (_err) {
            /* ignored - cleanup during shutdown */
        }

        /*  disconnect nodes  */
        this.sourceNode?.disconnect()
        this.gainNode?.disconnect()
        this.compressor?.disconnect()
        this.captureNode?.disconnect()

        /*  stop context  */
        await this.audioContext.close()

        this.isInitialized = false
    }
}

/*  SpeechFlow node for compression in audio-to-audio passing  */
export default class SpeechFlowNodeCompressor extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "compressor"

    /*  internal state  */
    private destroyed = false
    private sidechain = 0 // FIXME
    private compressor: AudioCompressor | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            thresholdDb: { type: "number", val: -18, match: (n: number) => n <= 0 && n >= -60 },
            ratio:       { type: "number", val: 4,   match: (n: number) => n >= 1 && n <= 20  },
            attackMs:    { type: "number", val: 10,  match: (n: number) => n >= 0 && n <= 100 },
            releaseMs:   { type: "number", val: 50,  match: (n: number) => n >= 0 && n <= 100 },
            kneeDb:      { type: "number", val: 6,   match: (n: number) => n >= 0 && n <= 100 },
            makeupDb:    { type: "number", val: 0,   match: (n: number) => n >= 0 && n <= 100 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  receive dashboard information  */
    async receiveDashboard (type: "audio" | "text", id: string, kind: "final" | "intermediate", value: number | string): Promise<void> {
        if (this.params.sidechain === "")
            return
        if (type === "audio" && id === this.params.sidechain)
            this.sidechain = value as number
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  setup compressor  */
        this.compressor = new AudioCompressor(
            this.config.audioSampleRate,
            this.config.audioChannels, {
                threshold: this.params.thresholdDb,
                ratio:     this.params.ratio,
                attack:    this.params.attackMs  / 1000,
                release:   this.params.releaseMs / 1000,
                knee:      this.params.kneeDb,
            }
        )
        await this.compressor.initialize()
        this.compressor.setGain(this.params.makeupDb)

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk & { payload: Buffer }, encoding, callback) {
                if (self.destroyed) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    /*  compress chunk  */
                    const payload = utils.convertBufToI16(chunk.payload)
                    self.compressor?.processChunk(payload).then((result) => {
                        const payload = utils.convertI16ToBuf(result.data)
                        chunk.payload = payload
                        this.push(chunk)
                        callback()
                    }).catch((error) => {
                        callback(new Error(`compression failed: ${error}`))
                    })
                }
            },
            final (callback) {
                if (self.destroyed) {
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
        /*  indicate destruction  */
        this.destroyed = true

        /*  destroy compressor  */
        if (this.compressor !== null) {
            await this.compressor.stop()
            this.compressor = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
