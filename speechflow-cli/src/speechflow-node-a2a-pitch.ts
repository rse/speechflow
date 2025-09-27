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

/*  parameter configuration  */
type AudioPitchShifterConfig = {
    rate?:      number
    tempo?:     number
    pitch?:     number
    semitones?: number
}

/*  audio pitch shifter class using SoundTouch WebAudio worklet  */
class AudioPitchShifter extends util.WebAudio {
    /*  internal state  */
    private pitchNode: AudioWorkletNode | null = null
    private config: Required<AudioPitchShifterConfig>

    /*  construct object  */
    constructor (
        sampleRate: number,
        channels:   number,
        config:     AudioPitchShifterConfig = {}
    ) {
        super(sampleRate, channels)
        this.config = {
            rate:      config.rate      ?? 1.0,
            tempo:     config.tempo     ?? 1.0,
            pitch:     config.pitch     ?? 1.0,
            semitones: config.semitones ?? 0.0
        }
    }

    /*  setup object  */
    public async setup (): Promise<void> {
        await super.setup()

        /*  add SoundTouch worklet module  */
        const packagePath = path.join(__dirname, "../node_modules/@soundtouchjs/audio-worklet")
        const workletPath = path.join(packagePath, "dist/soundtouch-worklet.js")
        await this.audioContext.audioWorklet.addModule(workletPath)

        /*  create SoundTouch worklet node  */
        this.pitchNode = new AudioWorkletNode(this.audioContext, "soundtouch-processor", {
            numberOfInputs:  1,
            numberOfOutputs: 1,
            outputChannelCount: [ this.channels ]
        })

        /*  set initial parameter values  */
        const params = this.pitchNode.parameters as Map<string, AudioParam>
        params.get("rate")!.value           = this.config.rate
        params.get("tempo")!.value          = this.config.tempo
        params.get("pitch")!.value          = this.config.pitch
        params.get("pitchSemitones")!.value = this.config.semitones

        /*  connect nodes: source -> pitch -> capture  */
        this.sourceNode!.connect(this.pitchNode)
        this.pitchNode.connect(this.captureNode!)
    }

    /*  update rate value  */
    public setRate (rate: number): void {
        const params = this.pitchNode?.parameters as Map<string, AudioParam>
        params?.get("rate")?.setValueAtTime(rate, this.audioContext.currentTime)
        this.config.rate = rate
    }

    /*  update tempo value  */
    public setTempo (tempo: number): void {
        const params = this.pitchNode?.parameters as Map<string, AudioParam>
        params?.get("tempo")?.setValueAtTime(tempo, this.audioContext.currentTime)
        this.config.tempo = tempo
    }

    /*  update pitch shift value  */
    public setPitch (pitch: number): void {
        const params = this.pitchNode?.parameters as Map<string, AudioParam>
        params?.get("pitch")?.setValueAtTime(pitch, this.audioContext.currentTime)
        this.config.pitch = pitch
    }

    /*  update pitch semitones setting  */
    public setSemitones (semitones: number): void {
        const params = this.pitchNode?.parameters as Map<string, AudioParam>
        params?.get("pitchSemitones")?.setValueAtTime(semitones, this.audioContext.currentTime)
        this.config.semitones = semitones
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

/*  SpeechFlow node for pitch adjustment using SoundTouch WebAudio  */
export default class SpeechFlowNodeA2APitch extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-pitch"

    /*  internal state  */
    private closing = false
    private pitchShifter: AudioPitchShifter | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            rate:      { type: "number",  val: 1.0,  match: (n: number) => n >= 0.25 && n <= 4.0 },
            tempo:     { type: "number",  val: 1.0,  match: (n: number) => n >= 0.25 && n <= 4.0 },
            pitch:     { type: "number",  val: 1.0,  match: (n: number) => n >= 0.25 && n <= 4.0 },
            semitones: { type: "number",  val: 0.0,  match: (n: number) => n >= -24  && n <= 24  }
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
                rate:      this.params.rate,
                tempo:     this.params.tempo,
                pitch:     this.params.pitch,
                semitones: this.params.semitones
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
                        const payload = util.convertI16ToBuf(result, self.config.audioLittleEndian)
                        chunk.payload = payload
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