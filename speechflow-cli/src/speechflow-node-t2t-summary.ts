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

/*  SpeechFlow node for text-to-text summarization  */
export default class SpeechFlowNodeT2TSummary extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-summary"

    /*  internal state  */
    private llm: LLM | null = null
    private accumulatedText = ""
    private sentencesSinceLastSummary = 0

    /*  internal LLM setup  */
    private setup: Config = {
        /*  English (EN) summarization  */
        "en": {
            systemPrompt:
                "You are a text summarizer.\n" +
                "Output only the summary.\n" +
                "Do NOT use markdown.\n" +
                "Do NOT give any explanations.\n" +
                "Do NOT give any introduction.\n" +
                "Do NOT give any comments.\n" +
                "Do NOT give any preamble.\n" +
                "Do NOT give any prolog.\n" +
                "Do NOT give any epilog.\n" +
                "Get to the point.\n" +
                "Summarize the following text into %N% sentences.\n" +
                "The text is:\n",
            chat: [
                { role: "user",      content: "The weather today is sunny and warm. Birds are singing in the trees. People are enjoying the outdoors." },
                { role: "assistant", content: "The weather is pleasant with sunshine, birdsong, and people outdoors." },
                { role: "user",      content: "John went to the store to buy groceries. He needed milk, bread, and eggs. The store was crowded but he found everything he needed." },
                { role: "assistant", content: "John successfully bought milk, bread, and eggs from a crowded store." }
            ]
        },

        /*  German (DE) summarization  */
        "de": {
            systemPrompt:
                "Du bist ein Textzusammenfasser.\n" +
                "Gib nur die Zusammenfassung aus.\n" +
                "Benutze KEIN Markdown.\n" +
                "Gib KEINE Erklärungen.\n" +
                "Gib KEINE Einleitung.\n" +
                "Gib KEINE Kommentare.\n" +
                "Gib KEINE Präambel.\n" +
                "Gib KEINEN Prolog.\n" +
                "Gib KEINEN Epilog.\n" +
                "Komme auf den Punkt.\n" +
                "Fasse den folgenden Text in %N% Sätzen zusammen.\n" +
                "Der Text ist:\n",
            chat: [
                { role: "user",      content: "Das Wetter heute ist sonnig und warm. Vögel singen in den Bäumen. Die Menschen genießen die Zeit im Freien." },
                { role: "assistant", content: "Das Wetter ist angenehm mit Sonnenschein, Vogelgesang und Menschen im Freien." },
                { role: "user",      content: "Hans ging in den Laden, um Lebensmittel zu kaufen. Er brauchte Milch, Brot und Eier. Der Laden war voll, aber er fand alles, was er brauchte." },
                { role: "assistant", content: "Hans kaufte erfolgreich Milch, Brot und Eier in einem vollen Laden." }
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
            lang:     { type: "string", pos: 0, val: "en",                     match: /^(?:en|de)$/ },
            size:     { type: "number", pos: 1, val: 4,                        match: (n: number) => n >= 1 && n <= 20 },
            trigger:  { type: "number", pos: 2, val: 8,                        match: (n: number) => n >= 1 && n <= 100 }
        })

        /*  tell effective mode  */
        this.log("info", `summarizing language "${this.params.lang}" ` +
            `via ${this.params.provider} LLM (model: ${this.params.model}), ` +
            `triggering every new ${this.params.trigger} sentences, ` +
            `summarizing into ${this.params.size} sentences`)

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  count sentences in text  */
    private countSentences (text: string): number {
        const matches = text.match(/[.;?!]/g)
        return matches ? matches.length : 0
    }

    /*  open node  */
    async open () {
        /*  reset internal state  */
        this.accumulatedText = ""
        this.sentencesSinceLastSummary = 0

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

        /*  provide text summarization  */
        const llm = this.llm!
        const summarize = async (text: string) => {
            const cfg = this.setup[this.params.lang]
            if (!cfg)
                throw new Error(`unsupported language: ${this.params.lang}`)
            return llm.complete({
                system:   cfg.systemPrompt.replace(/%N%/, this.params.size),
                messages: cfg.chat,
                prompt:   text
            })
        }

        /*  establish a transform stream for summarization  */
        const self = this
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
                    /*  accumulate text  */
                    if (self.accumulatedText.length > 0)
                        self.accumulatedText += " "
                    self.accumulatedText += chunk.payload

                    /*  count new sentences  */
                    const newSentences = self.countSentences(chunk.payload)
                    self.sentencesSinceLastSummary += newSentences
                    self.log("info", `accumulated ${self.sentencesSinceLastSummary} sentences ` +
                        `(trigger: ${self.params.trigger})`)

                    /*  check if we should generate a summary  */
                    if (self.sentencesSinceLastSummary >= self.params.trigger) {
                        self.sentencesSinceLastSummary = 0
                        self.log("info", `generating summary of accumulated text`)
                        const textToSummarize = self.accumulatedText
                        self.accumulatedText = ""
                        summarize(textToSummarize).then((summary) => {
                            const chunkNew = chunk.clone()
                            chunkNew.payload = summary
                            this.push(chunkNew)
                            callback()
                        }).catch((error: unknown) => {
                            callback(util.ensureError(error))
                        })
                    }
                    else
                        callback()
                }
            },
            final (callback) {
                /*  generate final summary if there is accumulated text  */
                if (self.accumulatedText.length > 0 && self.sentencesSinceLastSummary > 0) {
                    self.sentencesSinceLastSummary = 0
                    self.log("info", `generating final summary of accumulated text`)
                    const textToSummarize = self.accumulatedText
                    self.accumulatedText = ""
                    summarize(textToSummarize).then((summary) => {
                        const chunkNew = new SpeechFlowChunk(
                            self.timeZeroOffset, self.timeZeroOffset,
                            "final", "text", summary)
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        callback(util.ensureError(error))
                    })
                }
                else
                    callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  reset internal state  */
        this.accumulatedText = ""
        this.sentencesSinceLastSummary = 0

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
