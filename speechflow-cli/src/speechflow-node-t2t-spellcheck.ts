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

/*  SpeechFlow node for LLM-based text-to-text spellchecking  */
export default class SpeechFlowNodeT2TSpellcheck extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-spellcheck"

    /*  internal state  */
    private llm: LLM | null = null

    /*  internal LLM setup  */
    private setup: Config = {
        /*  English (EN) spellchecking  */
        "en": {
            systemPrompt:
                "You are a proofreader and spellchecker for English.\n" +
                "Output only the corrected text.\n" +
                "Do NOT use markdown.\n" +
                "Do NOT give any explanations.\n" +
                "Do NOT give any introduction.\n" +
                "Do NOT give any comments.\n" +
                "Do NOT give any preamble.\n" +
                "Do NOT give any prolog.\n" +
                "Do NOT give any epilog.\n" +
                "Do NOT change the grammar.\n" +
                "Do NOT use synonyms for words.\n" +
                "Keep all words.\n" +
                "Fill in missing commas.\n" +
                "Fill in missing points.\n" +
                "Fill in missing question marks.\n" +
                "Fill in missing hyphens.\n" +
                "Focus ONLY on the word spelling.\n" +
                "The text you have to correct is:\n",
            chat: [
                { role: "user",      content: "I luve my wyfe" },
                { role: "assistant", content: "I love my wife." },
                { role: "user",      content: "The weether is wunderfull!" },
                { role: "assistant", content: "The weather is wonderful!" },
                { role: "user",      content: "The life awesome but I'm hungry." },
                { role: "assistant", content: "The life is awesome, but I'm hungry." }
            ]
        },

        /*  German (DE) spellchecking  */
        "de": {
            systemPrompt:
                "Du bist ein Korrekturleser und Rechtschreibprüfer für Deutsch.\n" +
                "Gib nur den korrigierten Text aus.\n" +
                "Benutze KEIN Markdown.\n" +
                "Gib KEINE Erklärungen.\n" +
                "Gib KEINE Einleitung.\n" +
                "Gib KEINE Kommentare.\n" +
                "Gib KEINE Präambel.\n" +
                "Gib KEINEN Prolog.\n" +
                "Gib KEINEN Epilog.\n" +
                "Ändere NICHT die Grammatik.\n" +
                "Verwende KEINE Synonyme für Wörter.\n" +
                "Behalte alle Wörter bei.\n" +
                "Füge fehlende Kommas ein.\n" +
                "Füge fehlende Punkte ein.\n" +
                "Füge fehlende Fragezeichen ein.\n" +
                "Füge fehlende Bindestriche ein.\n" +
                "Füge fehlende Gedankenstriche ein.\n" +
                "Fokussiere dich NUR auf die Rechtschreibung der Wörter.\n" +
                "Der von dir zu korrigierende Text ist:\n",
            chat: [
                { role: "user",      content: "Ich ljebe meine Frao" },
                { role: "assistant", content: "Ich liebe meine Frau." },
                { role: "user",      content: "Die Wedter ist wunderschoen." },
                { role: "assistant", content: "Das Wetter ist wunderschön." },
                { role: "user",      content: "Das Leben einfach großartig aber ich bin hungrig." },
                { role: "assistant", content: "Das Leben ist einfach großartig, aber ich bin hungrig." }
            ]
        }
    }

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            lang:     { type: "string", pos: 0, val: "en",                     match: /^(?:de|en)$/ },
            provider: { type: "string",         val: "ollama",                 match: /^(?:openai|anthropic|google|ollama|transformers)$/ },
            api:      { type: "string",         val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?(:\d+)?$/ },
            model:    { type: "string",         val: "gemma3:4b-it-q4_K_M",    match: /^.+$/ },
            key:      { type: "string",         val: "",                       match: /^.*$/ }
        })

        /*  tell effective mode  */
        this.log("info", `spellchecking language "${this.params.lang}" ` +
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

        /*  provide text-to-text spellchecking  */
        const llm = this.llm!
        const spellcheck = async (text: string) => {
            const cfg = this.setup[this.params.lang]
            if (!cfg)
                throw new Error(`unsupported language: ${this.params.lang}`)
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
                    spellcheck(chunk.payload).then((payload) => {
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
