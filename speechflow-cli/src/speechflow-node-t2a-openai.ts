/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import OpenAI         from "openai"
import { Duration }   from "luxon"
import SpeexResampler from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for OpenAI text-to-speech conversion  */
export default class SpeechFlowNodeT2AOpenAI extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-openai"

    /*  internal state  */
    private openai:    OpenAI         | null = null
    private resampler: SpeexResampler | null = null
    private closing                          = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_OPENAI_KEY },
            api:      { type: "string", val: "https://api.openai.com/v1", match: /^https?:\/\/.+/ },
            voice:    { type: "string", val: "alloy",  pos: 0, match: /^(?:alloy|echo|fable|onyx|nova|shimmer)$/ },
            model:    { type: "string", val: "tts-1",  pos: 1, match: /^(?:tts-1|tts-1-hd)$/ },
            speed:    { type: "number", val: 1.0,      pos: 2, match: (n: number) => n >= 0.25 && n <= 4.0 }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("OpenAI API key not configured")

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

        /*  establish OpenAI API connection  */
        this.openai = new OpenAI({
            baseURL: this.params.api,
            apiKey:  this.params.key,
            timeout: 60000
        })

        /*  establish resampler from OpenAI's 24Khz PCM output
            to our standard audio sample rate (48KHz)  */
        this.resampler = new SpeexResampler(1, 24000, this.config.audioSampleRate, 7)

        /*  perform text-to-speech operation with OpenAI API  */
        const textToSpeech = async (text: string) => {
            this.log("info", `OpenAI TTS: send text "${text}"`)
            const response = await this.openai!.audio.speech.create({
                model:           this.params.model,
                voice:           this.params.voice,
                input:           text,
                response_format: "pcm",
                speed:           this.params.speed
            })

            /*  convert response to buffer (PCM 24kHz, 16-bit, little-endian)  */
            const arrayBuffer = await response.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)
            this.log("info", `OpenAI TTS: received audio (buffer length: ${buffer.byteLength})`)

            /*  resample from 24kHz to 48kHz  */
            const bufferResampled = this.resampler!.processChunk(buffer)
            this.log("info", `OpenAI TTS: forwarding resampled audio (buffer length: ${bufferResampled.byteLength})`)
            return bufferResampled
        }

        /*  create transform stream and connect it to the OpenAI API  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            async transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "")
                    callback()
                else {
                    let processTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                        processTimeout = null
                        callback(new Error("OpenAI TTS API timeout"))
                    }, 60 * 1000)
                    const clearProcessTimeout = () => {
                        if (processTimeout !== null) {
                            clearTimeout(processTimeout)
                            processTimeout = null
                        }
                    }
                    try {
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        const buffer = await textToSpeech(chunk.payload as string)
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }

                        /*  calculate actual audio duration from PCM buffer size  */
                        const durationMs = util.audioBufferDuration(buffer,
                            self.config.audioSampleRate, self.config.audioBitDepth) * 1000

                        /*  create new chunk with recalculated timestamps  */
                        const chunkNew = chunk.clone()
                        chunkNew.type         = "audio"
                        chunkNew.payload      = buffer
                        chunkNew.timestampEnd = Duration.fromMillis(chunkNew.timestampStart.toMillis() + durationMs)
                        clearProcessTimeout()
                        this.push(chunkNew)
                        callback()
                    }
                    catch (error) {
                        clearProcessTimeout()
                        callback(util.ensureError(error, "OpenAI TTS processing failed"))
                    }
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
        if (this.resampler !== null)
            this.resampler = null

        /*  destroy OpenAI API  */
        if (this.openai !== null)
            this.openai = null
    }
}
