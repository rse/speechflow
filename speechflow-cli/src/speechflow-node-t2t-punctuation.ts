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

/*  SpeechFlow node for text-to-text punctuation restoration  */
export default class SpeechFlowNodeT2TPunctuation extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-punctuation"

    /*  internal state  */
    private llm: LLM | null = null

    /*  internal LLM setup  */
    private setup: Config = {
        /*  English (EN) punctuation restoration  */
        "en": {
            systemPrompt:
                "You are a punctuation restoration specialist for English.\n" +
                "Your task is to add missing punctuation to unpunctuated text.\n" +
                "Output only the punctuated text.\n" +
                "Do NOT use markdown.\n" +
                "Do NOT give any explanations.\n" +
                "Do NOT give any introduction.\n" +
                "Do NOT give any comments.\n" +
                "Do NOT give any preamble.\n" +
                "Do NOT give any prolog.\n" +
                "Do NOT give any epilog.\n" +
                "Do NOT change the words.\n" +
                "Do NOT add or remove words.\n" +
                "Do NOT fix spelling errors.\n" +
                "Do NOT change the grammar.\n" +
                "Do NOT use synonyms.\n" +
                "Keep all original words exactly as they are.\n" +
                "Add periods at sentence endings.\n" +
                "Add commas where appropriate.\n" +
                "Add question marks for questions.\n" +
                "Add exclamation marks where appropriate.\n" +
                "Add colons and semicolons where appropriate.\n" +
                "Capitalize first letters of sentences.\n" +
                "The text you have to punctuate is:\n",
            chat: [
                { role: "user",      content: "hello how are you today" },
                { role: "assistant", content: "Hello, how are you today?" },
                { role: "user",      content: "i went to the store and bought some milk eggs and bread" },
                { role: "assistant", content: "I went to the store and bought some milk, eggs, and bread." },
                { role: "user",      content: "what time is it i need to leave soon" },
                { role: "assistant", content: "What time is it? I need to leave soon." },
                { role: "user",      content: "thats amazing i cant believe it worked" },
                { role: "assistant", content: "That's amazing! I can't believe it worked!" }
            ]
        },

        /*  German (DE) punctuation restoration  */
        "de": {
            systemPrompt:
                "Du bist ein Spezialist für Zeichensetzung im Deutschen.\n" +
                "Deine Aufgabe ist es, fehlende Satzzeichen in unpunktierten Text einzufügen.\n" +
                "Gib nur den punktierten Text aus.\n" +
                "Benutze KEIN Markdown.\n" +
                "Gib KEINE Erklärungen.\n" +
                "Gib KEINE Einleitung.\n" +
                "Gib KEINE Kommentare.\n" +
                "Gib KEINE Präambel.\n" +
                "Gib KEINEN Prolog.\n" +
                "Gib KEINEN Epilog.\n" +
                "Ändere NICHT die Wörter.\n" +
                "Füge KEINE Wörter hinzu oder entferne welche.\n" +
                "Korrigiere KEINE Rechtschreibfehler.\n" +
                "Ändere NICHT die Grammatik.\n" +
                "Verwende KEINE Synonyme.\n" +
                "Behalte alle ursprünglichen Wörter genau bei.\n" +
                "Füge Punkte am Satzende ein.\n" +
                "Füge Kommas an passenden Stellen ein.\n" +
                "Füge Fragezeichen bei Fragen ein.\n" +
                "Füge Ausrufezeichen an passenden Stellen ein.\n" +
                "Füge Doppelpunkte und Semikolons an passenden Stellen ein.\n" +
                "Großschreibe die ersten Buchstaben von Sätzen.\n" +
                "Der von dir zu punktierende Text ist:\n",
            chat: [
                { role: "user",      content: "hallo wie geht es dir heute" },
                { role: "assistant", content: "Hallo, wie geht es dir heute?" },
                { role: "user",      content: "ich bin in den laden gegangen und habe milch eier und brot gekauft" },
                { role: "assistant", content: "Ich bin in den Laden gegangen und habe Milch, Eier und Brot gekauft." },
                { role: "user",      content: "wie spät ist es ich muss bald los" },
                { role: "assistant", content: "Wie spät ist es? Ich muss bald los." },
                { role: "user",      content: "das ist fantastisch ich kann nicht glauben dass es funktioniert hat" },
                { role: "assistant", content: "Das ist fantastisch! Ich kann nicht glauben, dass es funktioniert hat!" }
            ]
        }
    }

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            provider: { type: "string",         val: "ollama",                 match: /^(?:openai|anthropic|google|ollama|transformers)$/ },
            api:      { type: "string",         val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?(:\d+)?$/ },
            model:    { type: "string",         val: "gemma3:4b-it-q4_K_M",    match: /^.+$/ },
            key:      { type: "string",         val: "",                       match: /^.*$/ },
            lang:     { type: "string", pos: 0, val: "en",                     match: /^(?:de|en)$/ }
        })

        /*  tell effective mode  */
        this.log("info", `punctuation restoration for language "${this.params.lang}" ` +
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
            temperature: 0.7
        })
        this.llm.on("log", (level: string, message: string) => {
            this.log(level as "info" | "warning" | "error", message)
        })
        await this.llm.open()

        /*  provide text-to-text punctuation restoration  */
        const llm = this.llm
        const punctuate = async (text: string) => {
            const cfg = this.setup[this.params.lang]
            if (!cfg)
                throw new Error(`unsupported language: ${this.params.lang}`)
            return llm.complete({
                system:   cfg.systemPrompt,
                messages: cfg.chat,
                prompt:   text
            })
        }

        /*  establish a transform stream for punctuation restoration  */
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
                    punctuate(chunk.payload).then((payload) => {
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
