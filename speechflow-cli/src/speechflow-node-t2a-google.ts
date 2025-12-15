/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as GoogleTTS from "@google-cloud/text-to-speech"
import { Duration }   from "luxon"
import SpeexResampler from "speex-resampler"
import * as arktype   from "arktype"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Google Cloud text-to-speech conversion  */
export default class SpeechFlowNodeT2AGoogle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-google"

    /*  internal state  */
    private client:    GoogleTTS.TextToSpeechClient | null = null
    private resampler: SpeexResampler               | null = null
    private closing                                        = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",         val: process.env.SPEECHFLOW_GOOGLE_KEY ?? "" },
            voice:    { type: "string", pos: 0, val: "en-US-Neural2-J" },
            language: { type: "string", pos: 1, val: "en-US" },
            speed:    { type: "number", pos: 2, val: 1.0, match: (n: number) => n >=  0.25 && n <=  4.0 },
            pitch:    { type: "number", pos: 3, val: 0.0, match: (n: number) => n >= -20.0 && n <= 20.0 }
        })

        /*  validate API key  */
        if (this.params.key === "")
            throw new Error("Google Cloud API credentials JSON key is required")

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

        /*  instantiate Google TTS client  */
        const data = util.run("Google Cloud API credentials key", () =>
            JSON.parse(this.params.key))
        const credentials = util.importObject("Google Cloud API credentials key",
            data,
            arktype.type({
                project_id:   "string",
                private_key:  "string",
                client_email: "string"
            })
        )
        this.client = new GoogleTTS.TextToSpeechClient({
            credentials: {
                private_key:  credentials.private_key,
                client_email: credentials.client_email
            },
            projectId: credentials.project_id
        })

        /*  establish resampler from Google TTS's output sample rate
            to our standard audio sample rate (48KHz)  */
        const googleSampleRate = 24000 /*  Google TTS outputs 24kHz for LINEAR16  */
        this.resampler = new SpeexResampler(1, googleSampleRate, this.config.audioSampleRate, 7)

        /*  perform text-to-speech operation with Google Cloud TTS API  */
        const textToSpeech = async (text: string) => {
            this.log("info", `Google TTS: send text "${text}"`)
            const [ response ] = await this.client!.synthesizeSpeech({
                input: { text },
                voice: {
                    languageCode: this.params.language,
                    name:         this.params.voice
                },
                audioConfig: {
                    audioEncoding:   "LINEAR16",
                    sampleRateHertz: googleSampleRate,
                    speakingRate:    this.params.speed,
                    pitch:           this.params.pitch
                }
            })
            if (!response.audioContent)
                throw new Error("no audio content returned from Google TTS")

            /*  convert response to buffer  */
            const buffer = Buffer.isBuffer(response.audioContent)
                ? response.audioContent
                : Buffer.from(response.audioContent)
            this.log("info", `Google TTS: received audio (buffer length: ${buffer.byteLength})`)

            /*  resample from Google's sample rate to our standard rate  */
            const bufferResampled = this.resampler!.processChunk(buffer)
            this.log("info", `Google TTS: forwarding resampled audio (buffer length: ${bufferResampled.byteLength})`)
            return bufferResampled
        }

        /*  create transform stream and connect it to the Google TTS API  */
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
                        callback(new Error("Google TTS API timeout"))
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
                        callback(util.ensureError(error, "Google TTS processing failed"))
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

        /*  destroy Google TTS client  */
        if (this.client !== null) {
            await this.client.close().catch((error) => {
                this.log("warning", `error closing Google TTS client: ${error}`)
            })
            this.client = null
        }
    }
}
