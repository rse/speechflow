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
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for OPUS text-to-text translation  */
export default class SpeechFlowNodeT2TOPUS extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-opus"

    /*  internal state  */
    private translator: Transformers.TranslationPipeline | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            src: { type: "string", pos: 0, val: "de", match: /^(?:de|en)$/ },
            dst: { type: "string", pos: 1, val: "en", match: /^(?:de|en)$/ }
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
        /*  track download progress when instantiating Transformers engine and model  */
        const model = `onnx-community/opus-mt-${this.params.src}-${this.params.dst}`
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
        try {
            const pipeline = Transformers.pipeline("translation", model, {
                cache_dir: path.join(this.config.cacheDir, "transformers"),
                dtype:     "q4",
                device:    "auto",
                progress_callback: progressCallback
            })
            this.translator = await pipeline
        }
        finally {
            /*  clear progress interval again  */
            clearInterval(interval)
        }

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const result = await this.translator!(text)
            const single = Array.isArray(result) ? result[0] : result
            return (single as Transformers.TranslationSingle).translation_text
        }

        /*  establish a transform stream and connect it to Transformers  */
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
        /*  shutdown Transformers  */
        if (this.translator !== null) {
            this.translator.dispose()
            this.translator = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

