/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream   from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for text-to-text modification via regex  */
export default class SpeechFlowNodeT2TModify extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-modify"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            match:   { type: "string", val: "" },
            replace: { type: "string", val: "" }
        })

        /*  sanity check parameters  */
        if (this.params.match === "")
            throw new Error("match parameter cannot be empty")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  compile regex pattern  */
        const regex = util.run("compiling regex pattern",
            () => new RegExp(this.params.match, "g"))

        /*  apply regex-based modification  */
        const modify = (text: string): string =>
            text.replace(regex, this.params.replace)

        /*  establish a transform stream and connect it to text modification  */
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
                    const payload = modify(chunk.payload)
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