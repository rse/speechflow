/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path             from "node:path"
import Stream           from "node:stream"

/*  external dependencies  */
import { AudioWorkletNode } from "node-web-audio-api"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  internal types  */
interface AudioExpanderConfig {
    thresholdDb?: number
    floorDb?:     number
    ratio?:       number
    attackMs?:    number
    releaseMs?:   number
    kneeDb?:      number
    makeupDb?:    number
}

/*  audio noise expander class  */
class AudioExpander extends util.WebAudio {
    /*  internal state  */
    private config:       Required<AudioExpanderConfig>
    private expanderNode: AudioWorkletNode | null = null

    /*  construct object  */
    constructor(
        sampleRate: number,
        channels:   number,
        config:     AudioExpanderConfig = {}
    ) {
        super(sampleRate, channels)

        /*  store configuration  */
        this.config = {
            thresholdDb: config.thresholdDb ?? -45,
            floorDb:     config.floorDb     ?? -64,
            ratio:       config.ratio       ?? 4.0,
            attackMs:    config.attackMs    ?? 10,
            releaseMs:   config.releaseMs   ?? 50,
            kneeDb:      config.kneeDb      ?? 6.0,
            makeupDb:    config.makeupDb    ?? 0
        }
    }

    /*  initialize object  */
    public async setup (): Promise<void> {
        await super.setup()

        /*  add audio worklet module  */
        const url = path.resolve(__dirname, "speechflow-node-a2a-expander-wt.js")
        await this.audioContext.audioWorklet.addModule(url)

        /*  create expander node  */
        this.expanderNode = new AudioWorkletNode(this.audioContext, "expander", {
            numberOfInputs:  1,
            numberOfOutputs: 1,
            processorOptions: {
                sampleRate: this.audioContext.sampleRate
            }
        })

        /*  configure expander node  */
        const currentTime = this.audioContext.currentTime
        const node = this.expanderNode!
        const params = node.parameters as Map<string, AudioParam>
        params.get("threshold")!.setValueAtTime(this.config.thresholdDb, currentTime)
        params.get("floor")!.setValueAtTime(this.config.floorDb, currentTime)
        params.get("ratio")!.setValueAtTime(this.config.ratio, currentTime)
        params.get("attack")!.setValueAtTime(this.config.attackMs / 1000, currentTime)
        params.get("release")!.setValueAtTime(this.config.releaseMs / 1000, currentTime)
        params.get("knee")!.setValueAtTime(this.config.kneeDb, currentTime)
        params.get("makeup")!.setValueAtTime(this.config.makeupDb, currentTime)

        /*  connect nodes  */
        this.sourceNode!.connect(this.expanderNode)
        this.expanderNode.connect(this.captureNode!)
    }

    public async destroy (): Promise<void> {
        /*  destroy expander node  */
        if (this.expanderNode !== null) {
            this.expanderNode.disconnect()
            this.expanderNode = null
        }

        /*  destroy parent  */
        await super.destroy()
    }
}

/*  SpeechFlow node for noise expander in audio-to-audio passing  */
export default class SpeechFlowNodeA2AExpander extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-expander"

    /*  internal state  */
    private closing = false
    private expander: AudioExpander | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            thresholdDb: { type: "number", val: -45, match: (n: number) => n <= 0   && n >= -100 },
            floorDb:     { type: "number", val: -64, match: (n: number) => n <= 0   && n >= -100 },
            ratio:       { type: "number", val: 4.0, match: (n: number) => n >= 1   && n <= 20   },
            attackMs:    { type: "number", val: 10,  match: (n: number) => n >= 0   && n <= 1000 },
            releaseMs:   { type: "number", val: 50,  match: (n: number) => n >= 0   && n <= 1000 },
            kneeDb:      { type: "number", val: 6.0, match: (n: number) => n >= 0   && n <= 40   },
            makeupDb:    { type: "number", val: 0,   match: (n: number) => n >= -24 && n <= 24   }
        })

        /*  sanity check floor vs threshold  */
        if (this.params.floorDb >= this.params.thresholdDb)
            throw new Error("floor dB must be less than threshold dB for proper expansion")

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  setup expander  */
        this.expander = new AudioExpander(
            this.config.audioSampleRate,
            this.config.audioChannels, {
                thresholdDb: this.params.thresholdDb,
                floorDb:     this.params.floorDb,
                ratio:       this.params.ratio,
                attackMs:    this.params.attackMs,
                releaseMs:   this.params.releaseMs,
                kneeDb:      this.params.kneeDb,
                makeupDb:    this.params.makeupDb
            }
        )
        await this.expander.setup()

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk & { payload: Buffer }, encoding, callback) {
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    /*  expand chunk  */
                    const payload = util.convertBufToI16(chunk.payload)
                    self.expander?.process(payload).then((result) => {
                        if (self.closing)
                            throw new Error("stream already destroyed")

                        /*  take over expanded data  */
                        const payload = util.convertI16ToBuf(result)
                        chunk.payload = payload
                        this.push(chunk)
                        callback()
                    }).catch((error: unknown) => {
                        if (!self.closing)
                            callback(util.ensureError(error, "expansion failed"))
                    })
                }
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

        /*  destroy expander  */
        if (this.expander !== null) {
            await this.expander.destroy()
            this.expander = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
