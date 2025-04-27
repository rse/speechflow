/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"
import { EventEmitter } from "node:events"

/*  external dependencies  */
import { Ollama }       from "ollama"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  internal utility types  */
type ConfigEntry = { systemPrompt: string, chat: Array<{ role: string, content: string }> }
type Config      = { [ key: string ]: ConfigEntry }

/*  SpeechFlow node for Gemma/Ollama text-to-text translation  */
export default class SpeechFlowNodeGemma extends SpeechFlowNode {
    /*  internal state  */
    private ollama: Ollama | null = null

    /*  internal LLM setup  */
    private setup: Config = {
        /*  English (EN) to German (DE) translation  */
        "en-de": {
            systemPrompt:
                "You are a translator.\n" +
                "Output only the requested text.\n" +
                "Do not use markdown.\n" +
                "Do not chat.\n" +
                "Do not show any explanations.\n" +
                "Do not show any introduction.\n" +
                "Do not show any preamble.\n" +
                "Do not show any prolog.\n" +
                "Do not show any epilog.\n" +
                "Get to the point.\n" +
                "Directly translate text from Enlish (EN) to German (DE) language.\n",
            chat: [
                { role: "user",   content: "I love my wife." },
                { role: "system", content: "Ich liebe meine Frau." },
                { role: "user",   content: "The weather is wonderful." },
                { role: "system", content: "Das Wetter ist wunderschön." },
                { role: "user",   content: "The live is awesome." },
                { role: "system", content: "Das Leben ist einfach großartig." }
            ]
        },

        /*  German (DE) to English (EN) translation  */
        "de-en": {
            systemPrompt:
                "You are a translator.\n" +
                "Output only the requested text.\n" +
                "Do not use markdown.\n" +
                "Do not chat.\n" +
                "Do not show any explanations. \n" +
                "Do not show any introduction.\n" +
                "Do not show any preamble. \n" +
                "Do not show any prolog. \n" +
                "Do not show any epilog. \n" +
                "Get to the point.\n" +
                "Directly translate text from German (DE) to English (EN) language.\n",
            chat: [
                { role: "user",   content: "Ich liebe meine Frau." },
                { role: "system", content: "I love my wife." },
                { role: "user",   content: "Das Wetter ist wunderschön." },
                { role: "system", content: "The weather is wonderful." },
                { role: "user",   content: "Das Leben ist einfach großartig." },
                { role: "system", content: "The live is awesome." }
            ]
        }
    }

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            api: { type: "string", val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?:\d+$/ },
            src: { type: "string", pos: 0, val: "de", match: /^(?:de|en)$/ },
            dst: { type: "string", pos: 1, val: "en", match: /^(?:de|en)$/ }
        })

        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination languages cannot be the same")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  instantiate Ollama API  */
        this.ollama = new Ollama({ host: this.params.api })

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const key = `${this.params.src}-${this.params.dst}`
            const cfg = this.setup[key]
            const response = await this.ollama!.chat({
                model: "gemma3:4b-it-q4_K_M",
                messages: [
                    { role: "system", content: cfg.systemPrompt },
                    ...cfg.chat,
                    { role: "user", content: text }
                ],
                keep_alive: "10m",
                options: {
                    repeat_penalty: 1.1,
                    temperature:    0.7,
                    seed:           1,
                    top_k:          10,
                    top_p:          0.5
                }
            })
            return response.message.content
        }

        /*  establish a duplex stream and connect it to Ollama  */
        const queue = new EventEmitter()
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding, callback) {
                const data = chunk.toString()
                if (data === "") {
                    queue.emit("result", "")
                    callback()
                }
                else {
                    translate(data).then((result) => {
                        queue.emit("result", result)
                        callback()
                    }).catch((err) => {
                        callback(err)
                    })
                }
            },
            read (size) {
                queue.once("result", (result: string) => {
                    this.push(result)
                })
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  shutdown Ollama  */
        if (this.ollama !== null) {
            this.ollama.abort()
            this.ollama = null
        }
    }
}

