/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream       from "node:stream"
import { Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  SpeechFlow node for data flow tracing  */
export default class SpeechFlowNodeTrace extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "trace"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            type: { type: "string", pos: 0, val: "audio", match: /^(?:audio|text)$/ },
            name: { type: "string", pos: 1, val: "trace" }
        })

        /*  declare node input/output format  */
        this.input  = this.params.type
        this.output = this.params.type
    }

    /*  open node  */
    async open () {
        /*  wrapper for local logging  */
        const log = (level: string, msg: string) => {
            if (this.params.name !== undefined)
                this.log(level, `[${this.params.name}]: ${msg}`)
            else
                this.log(level, msg)
        }

        /*  provide Transform stream  */
        const type = this.params.type
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                let error: Error | undefined
                const fmtTime = (t: Duration) => t.toFormat("hh:mm:ss.SSS")
                const fmtMeta = (meta: Map<string, any>) => {
                    if (meta.size === 0)
                        return "none"
                    else
                        return `{ ${Array.from(meta.entries())
                            .map(([ k, v ]) => `${k}: ${JSON.stringify(v)}`)
                            .join(", ")
                        } }`
                }
                if (Buffer.isBuffer(chunk.payload)) {
                    if (type === "audio")
                        log("debug", `writing ${type} chunk: start=${fmtTime(chunk.timestampStart)} ` +
                            `end=${fmtTime(chunk.timestampEnd)} kind=${chunk.kind} type=${chunk.type} ` +
                            `payload-type=Buffer payload-bytes=${chunk.payload.byteLength} ` +
                            `meta=${fmtMeta(chunk.meta)}`)
                    else
                        error = new Error(`writing ${type} chunk: seen Buffer instead of String chunk type`)
                }
                else {
                    if (type === "text")
                        log("debug", `writing ${type} chunk: start=${fmtTime(chunk.timestampStart)} ` +
                            `end=${fmtTime(chunk.timestampEnd)} kind=${chunk.kind} type=${chunk.type}` +
                            `payload-type=String payload-length=${chunk.payload.length} ` +
                            `payload-encoding=${encoding} payload-content="${chunk.payload.toString()}" ` +
                            `meta=${fmtMeta(chunk.meta)}`)
                    else
                        error = new Error(`writing ${type} chunk: seen String instead of Buffer chunk type`)
                }
                if (error !== undefined)
                    callback(error)
                else {
                    this.push(chunk, encoding)
                    callback()
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
    }
}
