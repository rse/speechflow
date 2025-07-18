/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                from "node:stream"

/*  external dependencies  */
import * as ElevenLabs       from "@elevenlabs/elevenlabs-js"
import { getStreamAsBuffer } from "get-stream"
import SpeexResampler        from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  SpeechFlow node for Elevenlabs text-to-speech conversion  */
export default class SpeechFlowNodeElevenlabs extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "elevenlabs"

    /*  internal state  */
    private elevenlabs: ElevenLabs.ElevenLabsClient | null = null
    private static speexInitialized = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_ELEVENLABS_KEY },
            voice:    { type: "string", val: "Brian",   pos: 0, match: /^(?:.+)$/ },
            language: { type: "string", val: "en",      pos: 1, match: /^(?:de|en)$/ },
            speed:    { type: "number", val: 1.05,      pos: 2, match: (n: number) => n >= 0.7 && n <= 1.2 },
            optimize: { type: "string", val: "latency", pos: 3, match: /^(?:latency|quality)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  one-time status of node  */
    async status () {
        const elevenlabs = new ElevenLabs.ElevenLabsClient({ apiKey: this.params.key })
        const subscription = await elevenlabs.user.subscription.get()
        const percent = subscription.characterCount / subscription.characterLimit
        return { usage: `${percent.toFixed(2)}%` }
    }

    /*  open node  */
    async open () {
        /*  establish ElevenLabs API connection  */
        this.elevenlabs = new ElevenLabs.ElevenLabsClient({
            apiKey: this.params.key
        })

        /*  determine maximum sample rate of ElevenLabs tier  */
        const maxSampleRates = {
            "free":                  16000,
            "starter":               22050,
            "creator":               24000,
            "independent_publisher": 44100,
            "growing_business":      44100,
            "enterprise":            44100
        }
        const sub = await this.elevenlabs.user.subscription.get()
        const tier = (sub.tier ?? "free") as keyof typeof maxSampleRates
        this.log("info", `determined ElevenLabs tier: "${tier}"`)
        let maxSampleRate = 16000
        if (maxSampleRates[tier] !== undefined)
            maxSampleRate = maxSampleRates[tier]
        this.log("info", `determined maximum audio sample rate: ${maxSampleRate}`)

        /*  determine voice for text-to-speech operation
            (for details see https://elevenlabs.io/text-to-speech)  */
        const voices = await this.elevenlabs.voices.getAll()
        let voice = voices.voices.find((voice) => voice.name === this.params.voice)
        if (voice === undefined) {
            voice = voices.voices.find((voice) => voice.name!.startsWith(this.params.voice))
            if (voice === undefined)
                throw new Error(`invalid ElevenLabs voice "${this.params.voice}"`)
        }
        const info = Object.keys(voice.labels ?? {}).length > 0 ?
            (", " + Object.entries(voice.labels!)
                .map(([ key, val ]) => `${key}: "${val}"`).join(", ")) : ""
        this.log("info", `selected voice: name: "${voice.name}"${info}`)

        /*  perform text-to-speech operation with Elevenlabs API  */
        const model = this.params.optimize === "quality" ?
            "eleven_multilingual_v2" :
            "eleven_flash_v2_5"
        const speechStream = (text: string) => {
            this.log("info", `ElevenLabs: send text "${text}"`)
            return this.elevenlabs!.textToSpeech.convert(voice.voiceId, {
                text,
                modelId:          model,
                languageCode:     this.params.language,
                outputFormat:     `pcm_${maxSampleRate}` as ElevenLabs.ElevenLabs.OutputFormat,
                seed:             815, /* arbitrary, but fixated by us */
                voiceSettings: {
                    speed:        this.params.speed
                }
            }, {
                timeoutInSeconds: 30,
                maxRetries:       10
            })
        }

        /*  establish resampler from ElevenLabs's maximum 24Khz
            output to our standard audio sample rate (48KHz)  */
        if (!SpeechFlowNodeElevenlabs.speexInitialized) {
            /*  at least once initialize resampler  */
            await SpeexResampler.initPromise
            SpeechFlowNodeElevenlabs.speexInitialized = true
        }
        const resampler = new SpeexResampler(1, maxSampleRate, this.config.audioSampleRate, 7)

        /*  create transform stream and connect it to the ElevenLabs API  */
        const log = (level: string, msg: string) => { this.log(level, msg) }
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    speechStream(chunk.payload).then((stream) => {
                        getStreamAsBuffer(stream).then((buffer) => {
                            const bufferResampled = resampler.processChunk(buffer)
                            log("info", `ElevenLabs: received audio (buffer length: ${buffer.byteLength})`)
                            const chunkNew = chunk.clone()
                            chunkNew.type = "audio"
                            chunkNew.payload = bufferResampled
                            this.push(chunkNew)
                            callback()
                        }).catch((error) => {
                            callback(error)
                        })
                    }).catch((error) => {
                        callback(error)
                    })
                }
            },
            final (callback) {
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  destroy stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  destroy ElevenLabs API  */
        if (this.elevenlabs !== null)
            this.elevenlabs = null
    }
}

