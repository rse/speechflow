/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"
import { EventEmitter } from "node:events"

/*  external dependencies  */
import * as DeepL       from "deepl-node"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  SpeechFlow node for DeepL text-to-text translations  */
export default class SpeechFlowNodeDeepL extends SpeechFlowNode {
    /*  internal state  */
    private deepl: DeepL.Translator | null = null

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

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
        const queue = new EventEmitter()
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding, callback) {
                const data = chunk.toString()
                if (data === "") {
                    queue.emit("result", "")
                    callback()
                }
                else {
                    translate(data).then((result) => {
                        queue.emit("result", result)
                        callback()
                    }).catch((err) => {
                        callback(err)
                    })
                }
            },
            read (size: number) {
                queue.once("result", (result: string) => {
                    this.push(result)
                })
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

