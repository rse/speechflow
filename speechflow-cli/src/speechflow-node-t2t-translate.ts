/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                              from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"
import { LLM, type LLMCompleteMessage }    from "./speechflow-util-llm"

/*  internal utility types  */
type ConfigEntry = { systemPrompt: string, chat: LLMCompleteMessage[] }
type Config      = { [ key: string ]: ConfigEntry }

/*  SpeechFlow node for LLM-based text-to-text translation  */
export default class SpeechFlowNodeT2TTranslate extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-translate"

    /*  internal state  */
    private llm: LLM | null = null

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
                "Preserve the original meaning, tone, and nuance.\n" +
                "Directly translate text from English (EN) to fluent and natural German (DE) language.\n",
            chat: [
                { role: "user",      content: "I love my wife." },
                { role: "assistant", content: "Ich liebe meine Frau." },
                { role: "user",      content: "The weather is wonderful." },
                { role: "assistant", content: "Das Wetter ist wunderschön." },
                { role: "user",      content: "The life is awesome." },
                { role: "assistant", content: "Das Leben ist einfach großartig." }
            ]
        },

        /*  German (DE) to English (EN) translation  */
        "de-en": {
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
                "Preserve the original meaning, tone, and nuance.\n" +
                "Directly translate text from German (DE) to fluent and natural English (EN) language.\n",
            chat: [
                { role: "user",      content: "Ich liebe meine Frau." },
                { role: "assistant", content: "I love my wife." },
                { role: "user",      content: "Das Wetter ist wunderschön." },
                { role: "assistant", content: "The weather is wonderful." },
                { role: "user",      content: "Das Leben ist einfach großartig." },
                { role: "assistant", content: "The life is awesome." }
            ]
        }
    }

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            src:      { type: "string", pos: 0, val: "de",                     match: /^(?:de|en)$/ },
            dst:      { type: "string", pos: 1, val: "en",                     match: /^(?:de|en)$/ },
            provider: { type: "string",         val: "ollama",                 match: /^(?:openai|anthropic|google|ollama)$/ },
            api:      { type: "string",         val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?(:\d+)?$/ },
            model:    { type: "string",         val: "gemma3:4b-it-q4_K_M",    match: /^.+$/ },
            key:      { type: "string",         val: "",                       match: /^.*$/ }
        })

        /*  validate translation direction  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination language must be different for translation")

        /*  tell effective mode  */
        this.log("info", `translating from language "${this.params.src}" to language "${this.params.dst}" ` +
            `via ${this.params.provider} LLM (model: ${this.params.model})`)

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  instantiate LLM  */
        this.llm = new LLM({
            provider:    this.params.provider,
            api:         this.params.api,
            model:       this.params.model,
            key:         this.params.key,
            temperature: 0.7,
            topP:        0.5
        })
        this.llm.on("log", (level: string, message: string) => {
            this.log(level as "info" | "warning" | "error", message)
        })
        await this.llm.open()

        /*  provide text-to-text translation  */
        const llm = this.llm!
        const translate = async (text: string) => {
            const key = `${this.params.src}-${this.params.dst}`
            const cfg = this.setup[key]
            if (!cfg)
                throw new Error(`unsupported language pair: ${key}`)
            return llm.complete({
                system:   cfg.systemPrompt,
                messages: cfg.chat,
                prompt:   text
            })
        }

        /*  establish a transform stream and connect it to LLM  */
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "") {
                    this.push(chunk)
                    callback()
                }
                else {
                    translate(chunk.payload).then((payload) => {
                        const chunkNew = chunk.clone()
                        chunkNew.payload = payload
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        callback(util.ensureError(error))
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
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  shutdown LLM  */
        if (this.llm !== null) {
            await this.llm.close()
            this.llm = null
        }
    }
}
