/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path             from "node:path"
import Stream           from "node:stream"

/*  external dependencies  */
import * as Transformers from "@huggingface/transformers"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  SpeechFlow node for OPUS text-to-text translation  */
export default class SpeechFlowNodeOPUS extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "opus"

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

        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination languages cannot be the same")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  instantiate OPUS  */
        const model = `onnx-community/opus-mt-${this.params.src}-${this.params.dst}`
        this.translator = await Transformers.pipeline("translation", model, {
            cache_dir: path.join(this.config.cacheDir, "opus"),
            dtype:     "q4",
            device:    "gpu"
        })
        if (this.translator === null)
            throw new Error("failed to instantiate translator pipeline")

        /*  provide text-to-text translation  */
        const translate = async (text: string) => {
            const result = await this.translator!(text)
            return Array.isArray(result) ?
                (result[0] as Transformers.TranslationSingle).translation_text :
                (result as Transformers.TranslationSingle).translation_text
        }

        /*  establish a duplex stream and connect it to OPUS  */
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

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  shutdown OPUS  */
        if (this.translator !== null) {
            this.translator.dispose()
            this.translator = null
        }
    }
}

