/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                from "node:stream"
import { EventEmitter }      from "node:events"

/*  external dependencies  */
import * as ElevenLabs       from "elevenlabs"
import { getStreamAsBuffer } from "get-stream"

/*  internal dependencies  */
import SpeechFlowNode        from "./speechflow-node"

/*
const elevenlabsVoices = {
    "drew":    { name: "Drew",    model: "eleven_multilingual_v2", lang: [ "en", "de" ] },
    "george":  { name: "George",  model: "eleven_multilingual_v2", lang: [ "en", "de" ] },
    "bill":    { name: "Bill",    model: "eleven_multilingual_v2", lang: [ "en", "de" ] },
    "daniel":  { name: "Daniel",  model: "eleven_multilingual_v1", lang: [ "en", "de" ] },
    "brian":   { name: "Brian",   model: "eleven_turbo_v2",        lang: [ "en"       ] },
    "sarah":   { name: "Sarah",   model: "eleven_multilingual_v2", lang: [ "en", "de" ] },
    "racel":   { name: "Racel",   model: "eleven_multilingual_v2", lang: [ "en", "de" ] },
    "grace":   { name: "Grace",   model: "eleven_multilingual_v1", lang: [ "en", "de" ] },
    "matilda": { name: "Matilda", model: "eleven_multilingual_v1", lang: [ "en", "de" ] },
    "alice":   { name: "Alice",   model: "eleven_turbo_v2",        lang: [ "en"       ] }
}
*/

export default class SpeechFlowNodeElevenlabs extends SpeechFlowNode {
    /*  internal state  */
    private elevenlabs: ElevenLabs.ElevenLabsClient | null = null

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_KEY_ELEVENLABS },
            voice:    { type: "string", val: "Brian",  pos: 0 },
            language: { type: "string", val: "de",     pos: 1 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        this.elevenlabs = new ElevenLabs.ElevenLabsClient({
            apiKey: this.params.key
        })
        const voices = await this.elevenlabs.voices.getAll()
        const voice = voices.voices.find((voice) => voice.name === this.params.voice)
        if (voice === undefined)
            throw new Error(`invalid ElevenLabs voice "${this.params.voice}"`)
        const speechStream = (text: string) => {
            return this.elevenlabs!.textToSpeech.convert(voice.voice_id, {
                text,
                optimize_streaming_latency: 2,
                output_format: "pcm_16000", // S16LE
                model_id: "eleven_flash_v2_5",
                /*
                voice_settings: {
                    stability: 0,
                    similarity_boost: 0
                }
                */
            }, {
                timeoutInSeconds: 30,
                maxRetries: 10
            })
        }
        const queue = new EventEmitter()
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void) {
                if (encoding !== "utf8" && encoding !== "utf-8")
                    callback(new Error("only text input supported by Elevenlabs node"))
                const data = chunk.toString()
                speechStream(data).then((stream) => {
                    getStreamAsBuffer(stream).then((buffer) => {
                        queue.emit("audio", buffer)
                        callback()
                    }).catch((error) => {
                        callback(error)
                    })
                }).catch((error) => {
                    callback(error)
                })
            },
            read (size: number) {
                queue.once("audio", (buffer: Buffer) => {
                    this.push(buffer, "binary")
                })
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
    }
}

