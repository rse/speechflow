/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path   from "node:path"
import Stream from "node:stream"

/*  external dependencies  */
import { AudioWorkletNode } from "node-web-audio-api"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

type AudioPitchShifterConfig = {
    shift?:     number
    frameSize?: number
    overlap?:   number
}

/*  audio pitch shifter class using WebAudio  */
class AudioPitchShifter extends util.WebAudio {
    /*  internal state  */
    private pitchNode: AudioWorkletNode | null = null
    private config: Required<AudioPitchShifterConfig>

    /*  construct object  */
    constructor(
        sampleRate: number,
        channels:   number,
        config:     AudioPitchShifterConfig = {}
    ) {
        super(sampleRate, channels)
        this.config = {
            shift:     config.shift     ?? 1.0,
            frameSize: config.frameSize ?? 2048,
            overlap:   config.overlap   ?? 0.5
        }
    }

    /*  setup object  */
    public async setup (): Promise<void> {
        await super.setup()

        /*  add pitch shifter worklet module  */
        const url = path.resolve(__dirname, "speechflow-node-a2a-pitch-wt.js")
        await this.audioContext.audioWorklet.addModule(url)

        /*  create pitch shifter worklet node  */
        this.pitchNode = new AudioWorkletNode(this.audioContext, "pitch-shifter", {
            numberOfInputs:  1,
            numberOfOutputs: 1,
            outputChannelCount: [ this.channels ],
            processorOptions: {
                shift:     this.config.shift,
                frameSize: this.config.frameSize,
                overlap:   this.config.overlap
            }
        })

        /*  connect nodes: source -> pitch -> capture  */
        this.sourceNode!.connect(this.pitchNode)
        this.pitchNode.connect(this.captureNode!)

        /*  configure initial pitch shift  */
        const currentTime = this.audioContext.currentTime
        const params = this.pitchNode.parameters as Map<string, AudioParam>
        params.get("shift")?.setValueAtTime(this.config.shift, currentTime)
    }

    /*  update pitch shift value  */
    public setShift (shift: number): void {
        if (this.pitchNode !== null) {
            const currentTime = this.audioContext.currentTime
            const params = this.pitchNode.parameters as Map<string, AudioParam>
            params.get("shift")?.setTargetAtTime(shift, currentTime, 0.01)
        }
        this.config.shift = shift
    }

    /*  destroy the pitch shifter  */
    public async destroy (): Promise<void> {
        /*  disconnect pitch node  */
        if (this.pitchNode !== null) {
            this.pitchNode.disconnect()
            this.pitchNode = null
        }

        /*  destroy parent  */
        await super.destroy()
    }
}

/*  SpeechFlow node for pitch adjustment using WebAudio  */
export default class SpeechFlowNodeA2APitch2 extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-pitch2"

    /*  internal state  */
    private closing = false
    private pitchShifter: AudioPitchShifter | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            shift:     { type: "number", val: 1.0,  match: (n: number) => n >= 0.25 && n <= 4.0 },
            frameSize: { type: "number", val: 2048, match: (n: number) => n >= 256  && n <= 8192 && (n & (n - 1)) === 0 },
            overlap:   { type: "number", val: 0.5,  match: (n: number) => n >= 0.0  && n <= 0.9 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  setup pitch shifter  */
        this.pitchShifter = new AudioPitchShifter(
            this.config.audioSampleRate,
            this.config.audioChannels, {
                shift:     this.params.shift,
                frameSize: this.params.frameSize,
                overlap:   this.params.overlap
            }
        )
        await this.pitchShifter.setup()

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
                    /*  shift pitch of audio chunk  */
                    const payload = util.convertBufToI16(chunk.payload, self.config.audioLittleEndian)
                    self.pitchShifter?.process(payload).then((result) => {
                        if (self.closing)
                            throw new Error("stream already destroyed")

                        /*  take over pitch-shifted data  */
                        const outputPayload = util.convertI16ToBuf(result, self.config.audioLittleEndian)

                        /*  final check before pushing to avoid race condition  */
                        if (self.closing)
                            throw new Error("stream already destroyed")

                        chunk.payload = outputPayload
                        this.push(chunk)
                        callback()
                    }).catch((error: unknown) => {
                        if (!self.closing)
                            callback(util.ensureError(error, "pitch shifting failed"))
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

        /*  destroy pitch shifter  */
        if (this.pitchShifter !== null) {
            await this.pitchShifter.destroy()
            this.pitchShifter = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}