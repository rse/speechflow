/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { getStreamAsBuffer } from "get-stream"
import SpeexResampler        from "speex-resampler"
import {
    PollyClient, SynthesizeSpeechCommand,
    Engine, VoiceId, LanguageCode, TextType
} from "@aws-sdk/client-polly"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Amazon Polly text-to-speech conversion  */
export default class SpeechFlowNodeT2AAmazon extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-amazon"

    /*  internal state  */
    private client: PollyClient | null = null
    private destroyed = false
    private resampler: SpeexResampler | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:        { type: "string", val: process.env.SPEECHFLOW_AMAZON_KEY },
            secKey:     { type: "string", val: process.env.SPEECHFLOW_AMAZON_KEY_SEC },
            region:     { type: "string", val: "eu-central-1" },
            voice:      { type: "string", val: "Amy", pos: 0, match: /^(?:Amy|Danielle|Joanna|Matthew|Ruth|Stephen|Vicki|Daniel)$/ },
            language:   { type: "string", val: "en",  pos: 1, match: /^(?:de|en)$/ }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("AWS Access Key not configured")
        if (!this.params.secKey)
            throw new Error("AWS Secret Access Key not configured")

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
        this.destroyed = false

        /*  establish AWS Polly connection  */
        this.client = new PollyClient({
            region: this.params.region,
            credentials: {
                accessKeyId:     this.params.key,
                secretAccessKey: this.params.secKey
            }
        })
        if (this.client === null)
            throw new Error("failed to establish AWS Polly client")

        /*  list of voices  */
        const voices = {
            "Amy":      { language: "en", languageCode: "en-GB", engine: "generative" },
            "Danielle": { language: "en", languageCode: "en-US", engine: "generative" },
            "Joanna":   { language: "en", languageCode: "en-US", engine: "generative" },
            "Matthew":  { language: "en", languageCode: "en-US", engine: "generative" },
            "Ruth":     { language: "en", languageCode: "en-US", engine: "generative" },
            "Stephen":  { language: "en", languageCode: "en-US", engine: "generative" },
            "Vicki":    { language: "de", languageCode: "de-DE", engine: "generative" },
            "Daniel":   { language: "de", languageCode: "de-DE", engine: "generative" },
        }
        const voiceConfig = voices[this.params.voice as keyof typeof voices]
        if (voiceConfig === undefined)
            throw new Error("unsupported voice")
        if (voiceConfig.language !== this.params.language)
            throw new Error(`voice does only support language "${voiceConfig.language}"`)

        /*  perform text-to-speech operation with AWS Polly API  */
        const textToSpeech = async (text: string) => {
            const cmd = new SynthesizeSpeechCommand({
                LanguageCode: voiceConfig.languageCode as LanguageCode,
                Engine:       voiceConfig.engine as Engine,
                VoiceId:      this.params.voice as VoiceId,
                OutputFormat: "pcm",
                SampleRate:   "16000", /* maximum supported for PCM output */
                TextType:     "text" as TextType,
                Text:         text
            })
            const res = await this.client!.send(cmd)
            const stream = res.AudioStream as AsyncIterable<Uint8Array> | null
            if (stream === null)
                throw new Error("stream not returned")
            const buffer = await getStreamAsBuffer(stream)
            const bufferResampled = this.resampler!.processChunk(buffer)
            return bufferResampled
        }

        /*  establish resampler from AWS Polly's maximum 16Khz output
            (for PCM output) to our standard audio sample rate (48KHz)  */
        this.resampler = new SpeexResampler(1, 16000, this.config.audioSampleRate, 7)

        /*  create transform stream and connect it to the AWS Polly API  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload.length > 0) {
                    self.log("debug", `send data (${chunk.payload.length} bytes): "${chunk.payload}"`)
                    textToSpeech(chunk.payload as string).then((buffer) => {
                        if (self.destroyed)
                            throw new Error("stream destroyed during processing")
                        const chunkNew = chunk.clone()
                        chunkNew.type = "audio"
                        chunkNew.payload = buffer
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        callback(util.ensureError(error, "failed to send to AWS Polly"))
                    })
                }
                else
                    callback()
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

        /*  destroy resampler  */
        if (this.resampler !== null)
            this.resampler = null

        /*  destroy AWS Polly API  */
        if (this.client !== null) {
            this.client.destroy()
            this.client = null
        }
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

