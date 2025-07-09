/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  SpeechFlow node for subtitle (text-to-text) "translations"  */
export default class SpeechFlowNodeSubtitle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "subtitle"

    /*  internal state  */
    private sequenceNo = 1

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            format:   { type: "string", pos: 0, val: "srt", match: /^(?:srt|vtt)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        this.sequenceNo = 1

        /*  provide text-to-subtitle conversion  */
        const convert = async (text: string) => {
            if (this.params.format === "srt") {
                const start = new Date().toISOString().substring(11, 23).replace(".", ",")
                const end   = start /* FIXME */
                text = `${this.sequenceNo++}\n` +
                    `${start} --> ${end}\n` +
                    `${text}\n\n`
            }
            else if (this.params.format === "vtt") {
                const start = new Date().toISOString().substring(11, 23)
                const end   = start /* FIXME */
                text = `${this.sequenceNo++}\n` +
                    `${start} --> ${end}\n` +
                    `${text}\n\n`
            }
            return text
        }

        /*  establish a duplex stream  */
        const textEncoding = this.config.textEncoding
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: Buffer | string, encoding, callback) {
                if (encoding === undefined || (encoding as string) === "buffer")
                    encoding = textEncoding
                if (Buffer.isBuffer(chunk))
                    chunk = chunk.toString(encoding)
                if (chunk === "") {
                    this.push("", encoding)
                    callback()
                }
                else {
                    convert(chunk).then((result) => {
                        this.push(result, encoding)
                        callback()
                    }).catch((err) => {
                        callback(err)
                    })
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
    }
}
