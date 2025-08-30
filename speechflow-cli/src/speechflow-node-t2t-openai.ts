/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import OpenAI from "openai"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  internal utility types  */
type ConfigEntry = { systemPrompt: string, chat: OpenAI.ChatCompletionMessageParam[] }
type Config      = { [ key: string ]: ConfigEntry }

/*  SpeechFlow node for OpenAI/GPT text-to-text translation  */
export default class SpeechFlowNodeOpenAI extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "openai"

    /*  internal state  */
    private openai: OpenAI | null = null

    /*  internal LLM setup  */
    private setup: Config = {
        /*  English (EN) spellchecking only  */
        "en-en": {
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

        /*  German (DE) spellchecking only  */
        "de-de": {
            systemPrompt:
                "Du bist ein Korrekturleser und Rechtschreibprüfer für Deutsch.\n" +
                "Gib nur den korrigierten Text aus.\n" +
                "Benutze KEIN Markdown.\n" +
                "Gib KEINE Erklärungen.\n" +
                "Gib KEINE Einleitung.\n" +
                "Gib KEINE Kommentare.\n" +
                "Gib KEINE Preamble.\n" +
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
        },

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
            src:   { type: "string", pos: 0, val: "de",                              match: /^(?:de|en)$/ },
            dst:   { type: "string", pos: 1, val: "en",                              match: /^(?:de|en)$/ },
            key:   { type: "string",         val: process.env.SPEECHFLOW_OPENAI_KEY, match: /^.+$/ },
            api:   { type: "string",         val: "https://api.openai.com/v1",       match: /^https?:\/\/.+/ },
            model: { type: "string",         val: "gpt-5-mini",                      match: /^.+$/ }
        })

        /*  tell effective mode  */
        if (this.params.src === this.params.dst)
            this.log("info", `OpenAI: operation mode: spellchecking for language "${this.params.src}"`)
        else
            this.log("info", `OpenAI: operation mode: translation from language "${this.params.src}"` +
                ` to language "${this.params.dst}"`)

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  validate API key  */
        if (!this.params.key)
            throw new Error("OpenAI API key is required")

        /*  instantiate OpenAI API  */
        this.openai = new OpenAI({
            baseURL: this.params.api,
            apiKey:  this.params.key,
            timeout: 30000
        })

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const key = `${this.params.src}-${this.params.dst}`
            const cfg = this.setup[key]
            if (!this.openai)
                throw new Error("OpenAI client not available")
            const completion = await this.openai.chat.completions.create({
                model:       this.params.model,
                temperature: this.params.model.includes("mini") ? 1.0 : 0.7,
                messages: [
                    { role: "system", content: cfg.systemPrompt },
                    ...cfg.chat,
                    { role: "user", content: text }
                ]
            })
            const content = completion?.choices?.[0]?.message?.content
            if (!content)
                throw new Error("OpenAI API returned empty content")
            return content
        }

        /*  establish a duplex stream and connect it to OpenAI  */
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
                    }).catch((err) => {
                        callback(err)
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
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  shutdown OpenAI  */
        if (this.openai !== null)
            this.openai = null
    }
}

