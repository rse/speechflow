/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as DeepL from "deepl-node"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for DeepL text-to-text translations  */
export default class SpeechFlowNodeDeepL extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "deepl"

    /*  internal state  */
    private deepl: DeepL.Translator | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_DEEPL_KEY ?? "" },
            src:      { type: "string", pos: 0, val: "de",      match: /^(?:de|en|fr|it)$/ },
            dst:      { type: "string", pos: 1, val: "en",      match: /^(?:de|en|fr|it)$/ },
            optimize: { type: "string", pos: 2, val: "latency", match: /^(?:latency|quality)$/ }
        })

        /*  validate API key  */
        if (this.params.key === "")
            throw new Error("DeepL API key is required")

        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination languages cannot be the same")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  one-time status of node  */
    async status () {
        const deepl = new DeepL.Translator(this.params.key)
        const usage = await deepl.getUsage()
        const limit = usage?.character?.limit ?? 1
        const percent = limit > 0 ? ((usage?.character?.count ?? 0) / limit * 100) : 0
        return { usage: `${percent.toFixed(8)}%` }
    }

    /*  open node  */
    async open () {
        /*  instantiate DeepL API SDK  */
        this.deepl = new DeepL.Translator(this.params.key)

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const src = this.params.src === "en" ? "en-US" : this.params.src
            const dst = this.params.dst === "en" ? "en-US" : this.params.dst
            const result = await this.deepl!.translateText(text, src, dst, {
                splitSentences: "off",
                modelType: this.params.optimize === "latency" ?
                    "latency_optimized" : "prefer_quality_optimized",
                preserveFormatting: true,
                formality: "prefer_more"
            })
            return (result?.text ?? text)
        }

        /*  establish a duplex stream and connect it to DeepL translation  */
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

        /*  shutdown DeepL API  */
        if (this.deepl !== null)
            this.deepl = null
    }
}

