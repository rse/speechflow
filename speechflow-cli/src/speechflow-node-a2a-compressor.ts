/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path             from "node:path"
import Stream           from "node:stream"
import { EventEmitter } from "node:events"

/*  external dependencies  */
import { GainNode, AudioWorkletNode } from "node-web-audio-api"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"
import { WebAudio }                        from "./speechflow-utils-audio"

/*  internal types  */
interface AudioCompressorConfig {
    thresholdDb?: number
    ratio?:       number
    attackMs?:    number
    releaseMs?:   number
    kneeDb?:      number
    makeupDb?:    number
}

/*  audio compressor class  */
class AudioCompressor extends WebAudio {
    /*  internal state  */
    private type:              "standalone" | "sidechain"
    private mode:              "compress" | "measure" | "adjust"
    private config:            Required<AudioCompressorConfig>
    private compressorNode:    AudioWorkletNode | null = null
    private gainNode:          GainNode | null = null

    /*  construct object  */
    constructor(
        sampleRate: number,
        channels:   number,
        type:       "standalone" | "sidechain" = "standalone",
        mode:       "compress" | "measure" | "adjust" = "compress",
        config:     AudioCompressorConfig = {}
    ) {
        super(sampleRate, channels)

        /*  store type and mode  */
        this.type = type
        this.mode = mode

        /*  store configuration  */
        this.config = {
            thresholdDb: config.thresholdDb ?? -23,
            ratio:       config.ratio       ?? 4.0,
            attackMs:    config.attackMs    ?? 10,
            releaseMs:   config.releaseMs   ?? 50,
            kneeDb:      config.kneeDb      ?? 6.0,
            makeupDb:    config.makeupDb    ?? 0
        }
    }

    /*  setup object  */
    public async setup (): Promise<void> {
        await super.setup()

        /*  add audio worklet module  */
        const url = path.resolve(__dirname, "speechflow-node-a2a-compressor-wt.js")
        await this.audioContext.audioWorklet.addModule(url)

        /*  create compressor worklet node  */
        if ((this.type === "standalone" && this.mode === "compress") ||
            (this.type === "sidechain"  && this.mode === "measure")    ) {
            this.compressorNode = new AudioWorkletNode(this.audioContext, "compressor", {
                numberOfInputs:  1,
                numberOfOutputs: 1,
                processorOptions: {
                    sampleRate: this.audioContext.sampleRate
                }
            })
        }

        /*  create gain node  */
        if ((this.type === "standalone" && this.mode === "compress") ||
            (this.type === "sidechain"  && this.mode === "adjust")     )
            this.gainNode = this.audioContext.createGain()

        /*  connect nodes (according to type and mode)  */
        if (this.type === "standalone" && this.mode === "compress") {
            this.sourceNode!.connect(this.compressorNode!)
            this.compressorNode!.connect(this.gainNode!)
            this.gainNode!.connect(this.captureNode!)
        }
        else if (this.type === "sidechain" && this.mode === "measure") {
            this.sourceNode!.connect(this.compressorNode!)
        }
        else if (this.type === "sidechain" && this.mode === "adjust") {
            this.sourceNode!.connect(this.gainNode!)
            this.gainNode!.connect(this.captureNode!)
        }

        /*  configure compressor worklet node  */
        const currentTime = this.audioContext.currentTime
        if ((this.type === "standalone" && this.mode === "compress") ||
            (this.type === "sidechain"  && this.mode === "measure")    ) {
            const node = this.compressorNode!
            const params = node.parameters as Map<string, AudioParam>
            params.get("threshold")!.setValueAtTime(this.config.thresholdDb, currentTime)
            params.get("ratio")!.setValueAtTime(this.config.ratio, currentTime)
            params.get("attack")!.setValueAtTime(this.config.attackMs / 1000, currentTime)
            params.get("release")!.setValueAtTime(this.config.releaseMs / 1000, currentTime)
            params.get("knee")!.setValueAtTime(this.config.kneeDb, currentTime)
            params.get("makeup")!.setValueAtTime(this.config.makeupDb, currentTime)
        }

        /*  configure gain node  */
        if ((this.type === "standalone" && this.mode === "compress") ||
            (this.type === "sidechain"  && this.mode === "adjust")     ) {
            const gain = Math.pow(10, this.config.makeupDb / 20)
            this.gainNode!.gain.setValueAtTime(gain, currentTime)
        }
    }

    public getGainReduction(): number {
        const processor = (this.compressorNode as any)?.port?.processor
        return processor?.reduction ?? 0
    }

    public setGain(decibel: number): void {
        const gain = Math.pow(10, decibel / 20)
        this.gainNode?.gain.setTargetAtTime(gain, this.audioContext.currentTime, 0.002)
    }
    public async destroy(): Promise<void> {
        await super.destroy()

        /*  destroy nodes  */
        if (this.compressorNode !== null) {
            this.compressorNode.disconnect()
            this.compressorNode = null
        }
        if (this.gainNode !== null) {
            this.gainNode.disconnect()
            this.gainNode = null
        }
    }
}

/*  SpeechFlow node for compression in audio-to-audio passing  */
export default class SpeechFlowNodeCompressor extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "compressor"

    /*  internal state  */
    private destroyed = false
    private compressor: AudioCompressor | null = null
    private bus: EventEmitter | null = null
    private intervalId: ReturnType<typeof setInterval> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            type:        { type: "string", val: "standalone", match: /^(?:standalone|sidechain)$/ },
            mode:        { type: "string", val: "compress",   match: /^(?:compress|measure|adjust)$/ },
            bus:         { type: "string", val: "compressor", match: /^.+$/ },
            thresholdDb: { type: "number", val: -23, match: (n: number) => n <= 0   && n >= -100 },
            ratio:       { type: "number", val: 4.0, match: (n: number) => n >= 1   && n <= 20   },
            attackMs:    { type: "number", val: 10,  match: (n: number) => n >= 0   && n <= 1000 },
            releaseMs:   { type: "number", val: 50,  match: (n: number) => n >= 0   && n <= 1000 },
            kneeDb:      { type: "number", val: 6.0, match: (n: number) => n >= 0   && n <= 40   },
            makeupDb:    { type: "number", val: 0,   match: (n: number) => n >= -24 && n <= 24   }
        })

        /*  sanity check mode and role  */
        if (this.params.type === "standalone" && this.params.mode !== "compress")
            throw new Error("type \"standalone\" implies mode \"compress\"")
        if (this.params.type === "sidechain" && this.params.mode === "compress")
            throw new Error("type \"sidechain\" implies mode \"measure\" or \"adjust\"")

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  setup compressor  */
        this.compressor = new AudioCompressor(
            this.config.audioSampleRate,
            this.config.audioChannels,
            this.params.type,
            this.params.mode, {
                thresholdDb: this.params.thresholdDb,
                ratio:       this.params.ratio,
                attackMs:    this.params.attackMs,
                releaseMs:   this.params.releaseMs,
                kneeDb:      this.params.kneeDb,
                makeupDb:    this.params.makeupDb
            }
        )
        await this.compressor.setup()

        /*  optionally establish sidechain processing  */
        if (this.params.type === "sidechain") {
            this.bus = this.accessBus(this.params.bus)
            if (this.params.mode === "measure") {
                this.intervalId = setInterval(() => {
                    const decibel = this.compressor?.getGainReduction()
                    this.bus?.emit("sidechain-decibel", decibel)
                }, 10)
            }
            else if (this.params.mode === "adjust") {
                this.bus.on("sidechain-decibel", (decibel: number) => {
                    this.compressor?.setGain(decibel)
                })
            }
        }

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
                    self.compressor?.process(payload).then((result) => {
                        if ((self.params.type === "standalone" && self.params.mode === "compress") ||
                            (self.params.type === "sidechain"  && self.params.mode === "adjust")     ) {
                            /*  take over compressed data  */
                            const payload = utils.convertI16ToBuf(result)
                            chunk.payload = payload
                        }
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

        /*  clear interval  */
        if (this.intervalId !== null) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }

        /*  destroy bus  */
        if (this.bus !== null)
            this.bus = null

        /*  destroy compressor  */
        if (this.compressor !== null) {
            await this.compressor.destroy()
            this.compressor = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
