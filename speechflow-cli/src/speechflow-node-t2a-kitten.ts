/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream         from "node:stream"

/*  external dependencies  */
import { KittenTTS }  from "kitten-tts-js"
import { Duration }   from "luxon"
import SpeexResampler from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Kitten text-to-speech conversion  */
export default class SpeechFlowNodeT2AKitten extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-kitten"

    /*  internal state  */
    private kitten:    KittenTTS      | null = null
    private resampler: SpeexResampler | null = null
    private closing                          = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            model:    { type: "string", val: "KittenML/kitten-tts-nano-0.8", pos: 0, match: /^.+$/ },
            voice:    { type: "string", val: "Bruno",  pos: 1, match: /^(?:Bella|Jasper|Luna|Bruno|Rosie|Hugo|Kiki|Leo)$/ },
            speed:    { type: "number", val: 1.25,     pos: 2, match: (n: number) => n >= 0.5 && n <= 2.0 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  one-time status of node  */
    async status () {
        return {}
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  establish Kitten TTS  */
        this.kitten = await KittenTTS.from_pretrained(this.params.model)
        if (this.kitten === null)
            throw new Error("failed to instantiate Kitten TTS")

        /*  establish resampler from Kitten's 24Khz
            output to our standard audio sample rate (48KHz)  */
        this.resampler = new SpeexResampler(1, 24000, this.config.audioSampleRate, 7)

        /*  perform text-to-speech operation with Kitten TTS API  */
        const text2speech = async (text: string) => {
            this.log("info", `Kitten TTS: input: "${text}"`)
            const audio = await this.kitten!.generate(text, {
                voice: this.params.voice,
                speed: this.params.speed
            })
            if (audio.sampling_rate !== 24000)
                throw new Error("expected 24KHz sampling rate in Kitten TTS output")

            /*  convert audio samples from PCM/F32/24Khz to PCM/I16/24KHz  */
            const samples = audio.data
            const buffer1 = Buffer.alloc(samples.length * 2)
            for (let i = 0; i < samples.length; i++) {
                const sample = Math.max(-1, Math.min(1, samples[i]))
                buffer1.writeInt16LE(sample * 0x7FFF, i * 2)
            }

            /*  resample audio samples from PCM/I16/24Khz to PCM/I16/48KHz  */
            if (this.resampler === null)
                throw new Error("resampler already destroyed")
            return this.resampler.processChunk(buffer1)
        }

        /*  create transform stream and connect it to the Kitten TTS API  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "")
                    callback()
                else {
                    let callbackCalled = false
                    let processTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                        processTimeout = null
                        if (!callbackCalled) {
                            callbackCalled = true
                            callback(new Error("Kitten TTS timeout"))
                        }
                    }, 60 * 1000)
                    const clearProcessTimeout = () => {
                        if (processTimeout !== null) {
                            clearTimeout(processTimeout)
                            processTimeout = null
                        }
                    }
                    text2speech(chunk.payload).then((buffer) => {
                        clearProcessTimeout()
                        if (callbackCalled)
                            return
                        callbackCalled = true
                        if (self.closing) {
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        self.log("info", `Kitten TTS: received audio (buffer length: ${buffer.byteLength})`)

                        /*  calculate actual audio duration from PCM buffer size  */
                        const durationMs = util.audioBufferDuration(buffer,
                            self.config.audioSampleRate, self.config.audioBitDepth) * 1000

                        /*  create new chunk with recalculated timestamps  */
                        const chunkNew        = chunk.clone()
                        chunkNew.type         = "audio"
                        chunkNew.payload      = buffer
                        chunkNew.timestampEnd = Duration.fromMillis(chunkNew.timestampStart.toMillis() + durationMs)
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        clearProcessTimeout()
                        if (callbackCalled)
                            return
                        callbackCalled = true
                        callback(util.ensureError(error, "Kitten TTS processing failed"))
                    })
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  destroy resampler  */
        if (this.resampler !== null) {
            this.resampler.destroy()
            this.resampler = null
        }

        /*  destroy Kitten TTS API  */
        if (this.kitten !== null) {
            await this.kitten.release()
            this.kitten = null
        }
    }
}

