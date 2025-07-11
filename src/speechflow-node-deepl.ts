/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  external dependencies  */
import * as DeepL       from "deepl-node"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

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
            key:      { type: "string", val: process.env.SPEECHFLOW_KEY_DEEPL },
            src:      { type: "string", pos: 0, val: "de",      match: /^(?:de|en-US)$/ },
            dst:      { type: "string", pos: 1, val: "en-US",   match: /^(?:de|en-US)$/ },
            optimize: { type: "string", pos: 2, val: "latency", match: /^(?:latency|quality)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  instantiate DeepL API SDK  */
        this.deepl = new DeepL.Translator(this.params.key)

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const result = await this.deepl!.translateText(text, this.params.src, this.params.dst, {
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

    /*  open node  */
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

