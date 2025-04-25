/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Stream           from "node:stream"
import { EventEmitter } from "node:events"
import SpeechFlowNode   from "./speechflow-node"
import * as DeepL       from "deepl-node"

export default class SpeechFlowNodeDeepL extends SpeechFlowNode {
    private translator: DeepL.Translator | null = null

    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        this.input  = "text"
        this.output = "text"
        this.stream = null

        this.configure({
            key: { type: "string" },
            src: { type: "string", pos: 1, val: "de",    match: /^(?:de|en-US)$/ },
            dst: { type: "string", pos: 2, val: "en-US", match: /^(?:de|en-US)$/ }
        })
    }

    async open () {
        /*  instantiate DeepL API SDK  */
        this.translator = new DeepL.Translator(this.params.key)

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const result = await this.translator!.translateText(text, this.params.src, this.params.dst, {
                splitSentences: "off"
            })
            return (result?.text ?? text)
        }

        /*  establish a duplex stream and connect it to the translation  */
        const queue = new EventEmitter()
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void) {
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

    async close () {
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
        if (this.translator !== null)
            this.translator = null
    }
}

