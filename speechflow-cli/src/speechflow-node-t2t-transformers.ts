/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path   from "node:path"
import Stream from "node:stream"

/*  external dependencies  */
import * as Transformers from "@huggingface/transformers"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  internal utility types  */
type ConfigEntry = { systemPrompt: string, chat: Array<{ role: string, content: string }> }
type Config      = { [ key: string ]: ConfigEntry }

/*  SpeechFlow node for Transformers text-to-text translation  */
export default class SpeechFlowNodeTransformers extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "transformers"

    /*  internal state  */
    private translator: Transformers.TranslationPipeline    | null = null
    private generator:  Transformers.TextGenerationPipeline | null = null

    /*  internal LLM setup  */
    private setup: Config = {
        /*  SmolLM3: English (EN) to German (DE) translation  */
        "SmolLM3:en-de": {
            systemPrompt:
                "/no_think\n" +
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

        /*  SmolLM3: German (DE) to English (EN) translation  */
        "SmolLM3:de-en": {
            systemPrompt:
                "/no_think\n" +
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
            src:   { type: "string", pos: 0, val: "de", match: /^(?:de|en)$/ },
            dst:   { type: "string", pos: 1, val: "en", match: /^(?:de|en)$/ },
            model: { type: "string", val: "OPUS", match: /^(?:OPUS|SmolLM3)$/ }
        })

        /*  sanity check parameters  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination languages cannot be the same")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        let model = ""

        /*  track download progress when instantiating Transformers engine and model  */
        const progressState = new Map<string, number>()
        const progressCallback: Transformers.ProgressCallback = (progress: any) => {
            let artifact = model
            if (typeof progress.file === "string")
                artifact += `:${progress.file}`
            let percent = 0
            if (typeof progress.loaded === "number" && typeof progress.total === "number")
                percent = (progress.loaded / progress.total) * 100
            else if (typeof progress.progress === "number")
                percent = progress.progress
            if (percent > 0)
                progressState.set(artifact, percent)
        }
        const interval = setInterval(() => {
            for (const [ artifact, percent ] of progressState) {
                this.log("info", `downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                if (percent >= 100.0)
                    progressState.delete(artifact)
            }
        }, 1000)

        /*  instantiate Transformers engine and model  */
        if (this.params.model === "OPUS") {
            model = `onnx-community/opus-mt-${this.params.src}-${this.params.dst}`
            const pipeline = Transformers.pipeline("translation", model, {
                cache_dir: path.join(this.config.cacheDir, "transformers"),
                dtype:     "q4",
                device:    "auto",
                progress_callback: progressCallback
            })
            this.translator = await pipeline
            if (this.translator === null)
                throw new Error("failed to instantiate translator pipeline")
        }
        else if (this.params.model === "SmolLM3") {
            model = "HuggingFaceTB/SmolLM3-3B-ONNX"
            const pipeline = Transformers.pipeline("text-generation", model, {
                cache_dir: path.join(this.config.cacheDir, "transformers"),
                dtype:     "q4",
                device:    "auto",
                progress_callback: progressCallback
            })
            this.generator = await pipeline
            if (this.generator === null)
                throw new Error("failed to instantiate generator pipeline")
        }
        else
            throw new Error("invalid model")

        /*  clear progress interval again  */
        clearInterval(interval)

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            if (this.params.model === "OPUS") {
                const result = await this.translator!(text)
                const single = Array.isArray(result) ? result[0] : result
                return (single as Transformers.TranslationSingle).translation_text
            }
            else if (this.params.model === "SmolLM3") {
                const key = `SmolLM3:${this.params.src}-${this.params.dst}`
                const cfg = this.setup[key]
                const messages = [
                    { role: "system", content: cfg.systemPrompt },
                    ...cfg.chat,
                    { role: "user", content: text }
                ]
                const result = await this.generator!(messages, {
                    max_new_tokens: 100,
                    temperature:    0.6,
                    top_p:          0.95,
                    streamer: new Transformers.TextStreamer(this.generator!.tokenizer, {
                        skip_prompt:         true,
                        skip_special_tokens: true
                    })
                })
                const single = Array.isArray(result) ? result[0] : result
                const generatedText = (single as Transformers.TextGenerationSingle).generated_text
                return typeof generatedText === "string" ?
                    generatedText :
                    generatedText.at(-1)!.content
            }
            else
                throw new Error("invalid model")
        }

        /*  establish a duplex stream and connect it to Transformers  */
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
                        chunk = chunk.clone()
                        chunk.payload = payload
                        this.push(chunk)
                        callback()
                    }).catch((error: unknown) => {
                        callback(utils.ensureError(error))
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

        /*  shutdown Transformers  */
        if (this.translator !== null) {
            this.translator.dispose()
            this.translator = null
        }
        if (this.generator !== null) {
            this.generator.dispose()
            this.generator = null
        }
    }
}

