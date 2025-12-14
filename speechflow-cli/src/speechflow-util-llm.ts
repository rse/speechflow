/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import EventEmitter                  from "node:events"

/*  external dependencies  */
import OpenAI                        from "openai"
import Anthropic                     from "@anthropic-ai/sdk"
import { GoogleGenAI }               from "@google/genai"
import { Ollama, type ListResponse } from "ollama"
import * as Transformers             from "@huggingface/transformers"

/*  own utility types  */
export type LLMCompleteMessage = {
    role:           "system" | "user" | "assistant"
    content:        string
}
export type LLMConfig = {
    provider?:      "openai" | "anthropic" | "google" | "ollama" | "transformers"
    api?:           string
    model?:         string
    key?:           string
    timeout?:       number
    temperature?:   number
    maxTokens?:     number
    topP?:          number
    cacheDir?:      string
}
export type LLMCompleteOptions = {
    system?:        string
    messages?:      LLMCompleteMessage[]
    prompt:         string
}

/*  LLM class for unified LLM access  */
export class LLM extends EventEmitter {
    /*  internal state  */
    private config:      Required<LLMConfig>
    private openai:      OpenAI                              | null = null
    private anthropic:   Anthropic                           | null = null
    private google:      GoogleGenAI                         | null = null
    private ollama:      Ollama                              | null = null
    private transformer: Transformers.TextGenerationPipeline | null = null
    private initialized                                             = false

    /*  construct LLM instance  */
    constructor (config: LLMConfig) {
        /*  pass-through to EventEmitter  */
        super()

        /*  provide configuration defaults  */
        this.config = {
            provider:      "openai",
            api:           "",
            model:         "",
            key:           "",
            timeout:       30 * 1000,
            temperature:   0.7,
            maxTokens:     1024,
            topP:          0.5,
            cacheDir:      "",
            ...config
        } as Required<LLMConfig>

        /*  validate configuration options  */
        if (this.config.key === "") {
            if (this.config.provider === "openai")
                this.config.key = process.env.SPEECHFLOW_OPENAI_KEY ?? ""
            else if (this.config.provider === "anthropic")
                this.config.key = process.env.SPEECHFLOW_ANTHROPIC_KEY ?? ""
            else if (this.config.provider === "google")
                this.config.key = process.env.SPEECHFLOW_GOOGLE_KEY ?? ""
            if (this.config.provider.match(/^(?:openai|anthropic|google)$/) && this.config.key === "")
                throw new Error(`API key is required for provider "${this.config.provider}"`)
        }
        if (this.config.model === "")
            throw new Error("model is required")
    }

    /*  internal logging helper  */
    private log (level: "info" | "warning" | "error", message: string): void {
        this.emit("log", level, message)
    }

    /*  initialize the LLM client  */
    async open (): Promise<void> {
        if (this.initialized)
            return
        if (this.config.provider === "openai") {
            /*  instantiate OpenAI API  */
            this.openai = new OpenAI({
                ...(this.config.api !== "" ? { baseURL: this.config.api } : {}),
                apiKey:  this.config.key,
                timeout: this.config.timeout
            })
        }
        else if (this.config.provider === "anthropic") {
            /*  instantiate Anthropic API  */
            this.anthropic = new Anthropic({
                ...(this.config.api !== "" ? { baseURL: this.config.api } : {}),
                apiKey:  this.config.key,
                timeout: this.config.timeout
            })
        }
        else if (this.config.provider === "google") {
            /*  instantiate Google API  */
            this.google = new GoogleGenAI({
                apiKey:      this.config.key,
                httpOptions: {
                    timeout: this.config.timeout,
                    ...(this.config.api !== "" ? { baseUrl: this.config.api } : {})
                }
            })
        }
        else if (this.config.provider === "ollama") {
            /*  instantiate Ollama API  */
            this.ollama = new Ollama({ host: this.config.api })

            /*  ensure the model is available  */
            let models: ListResponse
            try {
                models = await this.ollama.list()
            }
            catch (err) {
                throw new Error(`failed to connect to Ollama API at ${this.config.api}: ${err}`, { cause: err })
            }
            const exists = models.models.some((m) => m.name === this.config.model)
            if (!exists) {
                this.log("info", `LLM: model "${this.config.model}" still not present in Ollama -- ` +
                    "automatically downloading model")
                let artifact = ""
                let percent  = 0
                let lastLoggedPercent = -1
                const interval = setInterval(() => {
                    if (percent !== lastLoggedPercent) {
                        this.log("info", `LLM: downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                        lastLoggedPercent = percent
                    }
                }, 1000)
                try {
                    const progress = await this.ollama.pull({ model: this.config.model, stream: true })
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
        }
        else if (this.config.provider === "transformers") {
            /*  track download progress when instantiating Transformers pipeline  */
            const progressState = new Map<string, number>()
            const progressCallback: Transformers.ProgressCallback = (progress: any) => {
                let artifact = this.config.model
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
                    this.log("info", `LLM: downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                    if (percent >= 100.0)
                        progressState.delete(artifact)
                }
            }, 1000)

            /*  instantiate HuggingFace Transformers text generation pipeline  */
            try {
                const pipelinePromise = Transformers.pipeline("text-generation", this.config.model, {
                    ...(this.config.cacheDir !== "" ? { cache_dir: this.config.cacheDir } : {}),
                    dtype:             "q4",
                    device:            "auto",
                    progress_callback: progressCallback
                })
                this.transformer = await pipelinePromise
            }
            catch (err) {
                throw new Error(`failed to instantiate HuggingFace Transformers pipeline: ${err}`, { cause: err })
            }
            finally {
                clearInterval(interval)
            }
            if (this.transformer === null)
                throw new Error("failed to instantiate HuggingFace Transformers pipeline")
        }
        else {
            const exhaustive: never = this.config.provider
            throw new Error(`unsupported LLM provider: ${exhaustive}`)
        }
        this.log("info", `LLM: initialized ${this.config.provider} client ` +
            `(${this.config.api !== "" ? `api: ${this.config.api}, ` : ""}model: ${this.config.model})`)
        this.initialized = true
    }

    /*  perform a completion  */
    async complete (options: LLMCompleteOptions): Promise<string> {
        if (!this.initialized)
            throw new Error("LLM still not initialized")

        /*  build messages array  */
        const messages: LLMCompleteMessage[] = []
        if (options.system)
            messages.push({ role: "system", content: options.system })
        if (options.messages)
            messages.push(...options.messages)
        messages.push({ role: "user", content: options.prompt })

        /*  perform LLM query  */
        if (this.config.provider === "openai") {
            if (!this.openai)
                throw new Error("OpenAI client not available")

            /*  perform OpenAI chat completion  */
            const completion = await this.openai.chat.completions.create({
                model:       this.config.model,
                max_tokens:  this.config.maxTokens,
                temperature: this.config.temperature,
                top_p:       this.config.topP,
                messages:    messages as OpenAI.ChatCompletionMessageParam[]
            }).catch((err) => {
                throw new Error(`failed to perform OpenAI chat completion: ${err}`, { cause: err })
            })
            const content = completion?.choices?.[0]?.message?.content
            if (!content)
                throw new Error("OpenAI API returned empty content")
            return content
        }
        else if (this.config.provider === "anthropic") {
            if (!this.anthropic)
                throw new Error("Anthropic client not available")

            /*  separate system message from other messages for Anthropic API  */
            const systemMessage = messages.find((m) => m.role === "system")
            const chatMessages  = messages.filter((m) => m.role !== "system")

            /*  perform Anthropic chat completion  */
            const message = await this.anthropic.messages.create({
                model:       this.config.model,
                max_tokens:  this.config.maxTokens,
                temperature: this.config.temperature,
                top_p:       this.config.topP,
                system:      systemMessage?.content,
                messages:    chatMessages as Anthropic.MessageParam[]
            }).catch((err) => {
                throw new Error(`failed to perform Anthropic chat completion: ${err}`, { cause: err })
            })
            const content = message?.content?.[0]
            if (!content || content.type !== "text")
                throw new Error("Anthropic API returned empty or non-text content")
            return content.text
        }
        else if (this.config.provider === "google") {
            if (!this.google)
                throw new Error("Google client not available")

            /*  convert messages for Google API  */
            const systemInstruction =
                messages.find((m) => m.role === "system")?.content
            const contents =
                messages.filter((m) => m.role !== "system").map((m) => ({
                    role:  m.role === "assistant" ? "model" : "user",
                    parts: [ { text: m.content } ]
                }))

            /*  perform Google chat completion  */
            const response = await this.google.models.generateContent({
                model:    this.config.model,
                contents,
                config: {
                    maxOutputTokens: this.config.maxTokens,
                    temperature:     this.config.temperature,
                    topP:            this.config.topP,
                    ...(systemInstruction ? { systemInstruction } : {})
                }
            }).catch((err) => {
                throw new Error(`failed to perform Google chat completion: ${err}`, { cause: err })
            })
            const content = response?.text
            if (!content)
                throw new Error("Google API returned empty content")
            return content
        }
        else if (this.config.provider === "ollama") {
            if (!this.ollama)
                throw new Error("Ollama client not available")

            /*  perform Ollama chat completion  */
            const response = await this.ollama.chat({
                model:      this.config.model,
                messages,
                keep_alive: "10m",
                options: {
                    num_predict: this.config.maxTokens,
                    temperature: this.config.temperature,
                    top_p:       this.config.topP
                }
            }).catch((err) => {
                throw new Error(`failed to perform Ollama chat completion: ${err}`, { cause: err })
            })
            const content = response?.message?.content
            if (!content)
                throw new Error("Ollama API returned empty content")
            return content
        }
        else if (this.config.provider === "transformers") {
            if (!this.transformer)
                throw new Error("HuggingFace Transformers pipeline not available")

            /*  perform HuggingFace Transformers text generation  */
            const result = await this.transformer(messages, {
                max_new_tokens:  this.config.maxTokens,
                temperature:     this.config.temperature,
                top_p:           this.config.topP,
                do_sample:       true
            }).catch((err) => {
                throw new Error(`failed to perform HuggingFace Transformers text generation: ${err}`, { cause: err })
            })
            const single = Array.isArray(result) ? result[0] : result
            const generatedText = (single as Transformers.TextGenerationSingle).generated_text
            const content = typeof generatedText === "string" ?
                generatedText :
                generatedText.at(-1)?.content
            if (!content)
                throw new Error("HuggingFace Transformers API returned empty content")
            return content
        }
        else {
            const exhaustive: never = this.config.provider
            throw new Error(`unsupported LLM provider: ${exhaustive}`)
        }
    }

    /*  close the LLM client  */
    async close (): Promise<void> {
        if (!this.initialized)
            return
        if (this.config.provider === "openai")
            this.openai = null
        else if (this.config.provider === "anthropic")
            this.anthropic = null
        else if (this.config.provider === "google")
            this.google = null
        else if (this.config.provider === "ollama") {
            this.ollama?.abort()
            this.ollama = null
        }
        else if (this.config.provider === "transformers") {
            this.transformer?.dispose()
            this.transformer = null
        }
        this.initialized = false
    }
}
