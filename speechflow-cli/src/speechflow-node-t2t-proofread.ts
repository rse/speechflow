/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                              from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"
import { LLM, type LLMCompleteMessage }    from "./speechflow-util-llm"

/*  internal utility types  */
type PromptParts = {
    systemPrompt: string,
    chat:         LLMCompleteMessage[]
}
type Config = { [ key: string ]: PromptParts }

/*  SpeechFlow node for LLM-based text-to-text proofreading  */
export default class SpeechFlowNodeT2TProofread extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-proofread"

    /*  internal state  */
    private llm: LLM | null = null

    /*  internal LLM setup: prompt parts per language  */
    private setup: Config = {
        /*  English (EN) proofreading  */
        "en": {
            systemPrompt:
                "You are a strict text corrector for English.\n" +
                "Correct spelling, punctuation and grammar.\n" +
                "Output only the corrected text.\n" +
                "The text you have to correct is:\n",
            chat: [
                { role: "user",      content: "I luve my wyfe." },
                { role: "assistant", content: "I love my wife." },
                { role: "user",      content: "The weether is wunderfull!" },
                { role: "assistant", content: "The weather is wonderful!" },
                { role: "user",      content: "Hello how are you today" },
                { role: "assistant", content: "Hello, how are you today?" },
                { role: "user",      content: "I went to the store and bought some milk eggs and bread" },
                { role: "assistant", content: "I went to the store and bought some milk, eggs, and bread." },
                { role: "user",      content: "She don't likes apples." },
                { role: "assistant", content: "She doesn't like apples." },
                { role: "user",      content: "Yesterday I go to the park." },
                { role: "assistant", content: "Yesterday I went to the park." }
            ]
        },

        /*  German (DE) proofreading  */
        "de": {
            systemPrompt:
                "Du bist ein strikter Textkorrektor für Deutsch.\n" +
                "Korrigiere die Rechtschreibung, die Zeichensetzung und die Grammatik.\n" +
                "Gib nur den korrigierten Text aus.\n" +
                "Der von dir zu korrigierende Text ist:\n",
            chat: [
                { role: "user",      content: "Ich ljebe meine Frao." },
                { role: "assistant", content: "Ich liebe meine Frau." },
                { role: "user",      content: "Die Wedter ist wunderschoen." },
                { role: "assistant", content: "Das Wetter ist wunderschön." },
                { role: "user",      content: "Hallo wie geht es dir heute" },
                { role: "assistant", content: "Hallo, wie geht es dir heute?" },
                { role: "user",      content: "Ich bin in den Laden gegangen und habe Milch Eier und Brot gekauft" },
                { role: "assistant", content: "Ich bin in den Laden gegangen und habe Milch, Eier und Brot gekauft." },
                { role: "user",      content: "Er gehen nach Hause." },
                { role: "assistant", content: "Er geht nach Hause." },
                { role: "user",      content: "Gestern ich gehe in den Park." },
                { role: "assistant", content: "Gestern ging ich in den Park." }
            ]
        }
    }

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            lang:        { type: "string",  pos: 0, val: "en",                     match: /^(?:de|en)$/ },
            provider:    { type: "string",          val: "ollama",                 match: /^(?:openai|anthropic|google|ollama|transformers)$/ },
            api:         { type: "string",          val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?(:\d+)?$/ },
            model:       { type: "string",          val: "gemma4:e4b",             match: /^.+$/ },
            key:         { type: "string",          val: "",                       match: /^.*$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  tell effective mode  */
        this.log("info", `proofreading language "${this.params.lang}" ` +
            `via ${this.params.provider} LLM (model: ${this.params.model})`)

        /*  instantiate LLM  */
        this.llm = new LLM({
            provider:    this.params.provider,
            api:         this.params.api,
            model:       this.params.model,
            key:         this.params.key,
            temperature: 0.7
        })
        this.llm.on("log", (level: string, message: string) => {
            this.log(level as "info" | "warning" | "error", message)
        })
        await this.llm.open()

        /*  provide text-to-text proofreading  */
        const llm = this.llm
        const proofread = async (text: string) => {
            const cfg = this.setup[this.params.lang]
            if (!cfg)
                throw new Error(`unsupported language: ${this.params.lang}`)
            this.log("info", `input: "${text}"`)
            const output = await llm.complete({
                system:   cfg.systemPrompt,
                messages: cfg.chat,
                prompt:   text
            })
            this.log("info", `output: "${output}"`)
            return output
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
                    if (chunk.kind === "final") {
                        proofread(chunk.payload).then((payload) => {
                            const chunkNew = chunk.clone()
                            chunkNew.payload = payload
                            this.push(chunkNew)
                            callback()
                        }).catch((error: unknown) => {
                            callback(util.ensureError(error))
                        })
                    }
                    else {
                        this.push(chunk)
                        callback()
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
