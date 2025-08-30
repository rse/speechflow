/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream     from "node:stream"

/*  external dependencies  */
import { Ollama, type ListResponse } from "ollama"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  internal utility types  */
type ConfigEntry = { systemPrompt: string, chat: Array<{ role: string, content: string }> }
type Config      = { [ key: string ]: ConfigEntry }

/*  SpeechFlow node for Ollama text-to-text translation  */
export default class SpeechFlowNodeOllama extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "ollama"

    /*  internal state  */
    private ollama: Ollama | null = null

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
            api:   { type: "string", val: "http://127.0.0.1:11434", match: /^https?:\/\/.+?:\d+$/ },
            model: { type: "string", val: "gemma3:4b-it-q4_K_M", match: /^.+$/ },
            src:   { type: "string", pos: 0, val: "de", match: /^(?:de|en)$/ },
            dst:   { type: "string", pos: 1, val: "en", match: /^(?:de|en)$/ }
        })

        /*  tell effective mode  */
        if (this.params.src === this.params.dst)
            this.log("info", `Ollama: operation mode: spellchecking for language "${this.params.src}"`)
        else
            this.log("info", `Ollama: operation mode: translation from language "${this.params.src}"` +
                ` to language "${this.params.dst}"`)

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  instantiate Ollama API  */
        this.ollama = new Ollama({ host: this.params.api })

        /*  ensure the model is available  */
        let models: ListResponse
        try {
            models = await this.ollama.list()
        }
        catch (err) {
            throw new Error(`failed to connect to Ollama API at ${this.params.api}: ${err}`)
        }
        const exists = models.models.some((m) => m.name === this.params.model)
        if (!exists) {
            this.log("info", `Ollama: model "${this.params.model}" still not present in Ollama -- ` +
                "automatically downloading model")
            let artifact = ""
            let percent  = 0
            let lastLoggedPercent = -1
            const interval = setInterval(() => {
                if (percent !== lastLoggedPercent) {
                    this.log("info", `downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                    lastLoggedPercent = percent
                }
            }, 1000)
            try {
                const progress = await this.ollama.pull({ model: this.params.model, stream: true })
                for await (const event of progress) {
                    if (event.digest)
                        artifact = event.digest
                    if (event.completed && event.total)
                        percent = (event.completed / event.total) * 100
                }
            }
            finally {
                clearInterval(interval)
            }
        }
        else
            this.log("info", `Ollama: model "${this.params.model}" already present in Ollama`)

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const key = `${this.params.src}-${this.params.dst}`
            const cfg = this.setup[key]
            const response = await this.ollama!.chat({
                model: this.params.model,
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
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    if (chunk.payload === "") {
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

        /*  shutdown Ollama  */
        if (this.ollama !== null) {
            this.ollama.abort()
            this.ollama = null
        }
    }
}

