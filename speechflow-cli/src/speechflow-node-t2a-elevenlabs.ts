/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as ElevenLabs       from "@elevenlabs/elevenlabs-js"
import { getStreamAsBuffer } from "get-stream"
import { Duration }          from "luxon"
import SpeexResampler        from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Elevenlabs text-to-speech conversion  */
export default class SpeechFlowNodeT2AElevenlabs extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-elevenlabs"

    /*  internal state  */
    private elevenlabs: ElevenLabs.ElevenLabsClient | null = null
    private closing = false
    private resampler: SpeexResampler | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:        { type: "string", val: process.env.SPEECHFLOW_ELEVENLABS_KEY },
            voice:      { type: "string", val: "Brian",   pos: 0, match: /^(?:Brittney|Cassidy|Leonie|Mark|Brian)$/ },
            language:   { type: "string", val: "en",      pos: 1, match: /^(?:de|en)$/ },
            speed:      { type: "number", val: 1.00,      pos: 2, match: (n: number) => n >= 0.7 && n <= 1.2 },
            stability:  { type: "number", val: 0.5,       pos: 3, match: (n: number) => n >= 0.0 && n <= 1.0 },
            similarity: { type: "number", val: 0.75,      pos: 4, match: (n: number) => n >= 0.0 && n <= 1.0 },
            optimize:   { type: "string", val: "latency", pos: 5, match: /^(?:latency|quality)$/ }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("ElevenLabs API key not configured")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  one-time status of node  */
    async status () {
        try {
            const elevenlabs = new ElevenLabs.ElevenLabsClient({ apiKey: this.params.key })
            const subscription = await elevenlabs.user.subscription.get()
            const percent = subscription.characterLimit > 0
                ? subscription.characterCount / subscription.characterLimit
                : 0
            return { usage: `${percent.toFixed(2)}%` }
        }
        catch (_error) {
            return { usage: "unknown" }
        }
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

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
        let voice = voices.voices.find((v) => v.name === this.params.voice)
        if (voice === undefined) {
            voice = voices.voices.find((v) => (v.name ?? "").startsWith(this.params.voice))
            if (voice === undefined)
                throw new Error(`invalid ElevenLabs voice "${this.params.voice}"`)
        }
        const labels = voice.labels ?? {}
        const info = Object.keys(labels).length > 0
            ? ", " + Object.entries(labels).map(([ key, val ]) => `${key}: "${val}"`).join(", ")
            : ""
        this.log("info", `selected voice: name: "${voice.name}"${info}`)

        /*  perform text-to-speech operation with Elevenlabs API  */
        const model = this.params.optimize === "quality"
            ? "eleven_turbo_v2_5"
            : "eleven_flash_v2_5"
        const speechStream = (text: string) => {
            this.log("info", `ElevenLabs: send text "${text}"`)
            return this.elevenlabs!.textToSpeech.convert(voice.voiceId, {
                text,
                modelId:          model,
                languageCode:     this.params.language,
                outputFormat:     `pcm_${maxSampleRate}` as ElevenLabs.ElevenLabs.OutputFormat,
                seed:             815, /*  arbitrary, but fixated by us  */
                voiceSettings: {
                    speed:           this.params.speed,
                    stability:       this.params.stability,
                    similarityBoost: this.params.similarity
                }
            }, {
                timeoutInSeconds: 30,
                maxRetries:       10
            })
        }

        /*  establish resampler from ElevenLabs's maximum 24Khz
            output to our standard audio sample rate (48KHz)  */
        this.resampler = new SpeexResampler(1, maxSampleRate, this.config.audioSampleRate, 7)

        /*  create transform stream and connect it to the ElevenLabs API  */
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
                else {
                    let processTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                        processTimeout = null
                        callback(new Error("ElevenLabs API timeout"))
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
                        const stream = await speechStream(chunk.payload as string)
                        const buffer = await getStreamAsBuffer(stream)
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        self.log("info", `ElevenLabs: received audio (buffer length: ${buffer.byteLength})`)
                        const bufferResampled = self.resampler!.processChunk(buffer)
                        self.log("info", "ElevenLabs: forwarding resampled audio " +
                            `(buffer length: ${bufferResampled.byteLength})`)

                        /*  calculate actual audio duration from PCM buffer size  */
                        const durationMs = util.audioBufferDuration(bufferResampled,
                            self.config.audioSampleRate, self.config.audioBitDepth) * 1000

                        /*  create new chunk with recalculated timestamps  */
                        const chunkNew = chunk.clone()
                        chunkNew.type         = "audio"
                        chunkNew.payload      = bufferResampled
                        chunkNew.timestampEnd = Duration.fromMillis(chunkNew.timestampStart.toMillis() + durationMs)
                        clearProcessTimeout()
                        this.push(chunkNew)
                        callback()
                    }
                    catch (error) {
                        clearProcessTimeout()
                        callback(util.ensureError(error, "ElevenLabs processing failed"))
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

        /*  destroy ElevenLabs API  */
        if (this.elevenlabs !== null)
            this.elevenlabs = null
    }
}

