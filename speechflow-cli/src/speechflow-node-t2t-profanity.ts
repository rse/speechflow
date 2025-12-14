/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream       from "node:stream"

/*  external dependencies  */
import BadWordsNext from "bad-words-next"
import en           from "bad-words-next/lib/en"
import de           from "bad-words-next/lib/de"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  language data mapping  */
const langData: { [ lang: string ]: typeof en } = { en, de }

/*  SpeechFlow node for text-to-text profanity filtering  */
export default class SpeechFlowNodeT2TProfanity extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-profanity"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            lang:        { type: "string", val: "en", match: /^(?:en|de)$/ },
            placeholder: { type: "string", val: "***" },
            mode:        { type: "string", val: "replace", match: /^(?:replace|repeat)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  create profanity filter instance  */
        const filter = util.run("creating profanity filter", () =>
            new BadWordsNext({
                data:            langData[this.params.lang],
                placeholder:     this.params.placeholder,
                placeholderMode: this.params.mode as "replace" | "repeat"
            })
        )

        /*  apply profanity filtering  */
        const censor = (text: string): string =>
            filter.filter(text)

        /*  establish a transform stream and connect it to profanity filtering  */
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
                    const payload = censor(chunk.payload)
                    const chunkNew = chunk.clone()
                    chunkNew.payload = payload
                    this.push(chunkNew)
                    callback()
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
