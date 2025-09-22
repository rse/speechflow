/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for data flow tracing  */
export default class SpeechFlowNodeX2XTrace extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "x2x-trace"

    /*  internal state  */
    private closing = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            type:      { type: "string", pos: 0, val: "audio", match: /^(?:audio|text)$/ },
            name:      { type: "string", pos: 1, val: "trace" },
            mode:      { type: "string", pos: 2, val: "filter", match: /^(?:filter|sink)$/ },
            dashboard: { type: "string",         val: "" }
        })

        /*  sanity check parameters  */
        if (this.params.dashboard !== "" && this.params.type === "audio")
            throw new Error("only trace nodes of type \"text\" can export to dashboard")

        /*  declare node input/output format  */
        this.input  = this.params.type
        if (this.params.mode === "filter")
            this.output = this.params.type
        else if (this.params.mode === "sink")
            this.output = "none"
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

        /*  clear destruction flag  */
        this.closing = false

        /*  helper functions for formatting  */
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
        const fmtChunkBase = (chunk: SpeechFlowChunk) =>
            `chunk: type=${chunk.type} ` +
            `kind=${chunk.kind} ` +
            `start=${fmtTime(chunk.timestampStart)} ` +
            `end=${fmtTime(chunk.timestampEnd)} `

        /*  provide Transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                let error: Error | undefined
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (Buffer.isBuffer(chunk.payload)) {
                    if (self.params.type === "audio")
                        log("debug", fmtChunkBase(chunk) +
                            `payload-type=Buffer payload-length=${chunk.payload.byteLength} ` +
                            `meta=${fmtMeta(chunk.meta)}`)
                    else
                        error = new Error(`${self.params.type} chunk: seen Buffer instead of String chunk type`)
                }
                else {
                    if (self.params.type === "text") {
                        log("debug", fmtChunkBase(chunk) +
                            `payload-type=String payload-length=${chunk.payload.length} ` +
                            `payload-content="${chunk.payload.toString()}" ` +
                            `meta=${fmtMeta(chunk.meta)}`)
                        if (self.params.dashboard !== "")
                            self.sendDashboard("text", self.params.dashboard, chunk.kind, chunk.payload.toString())
                    }
                    else
                        error = new Error(`${self.params.type} chunk: seen String instead of Buffer chunk type`)
                }
                if (self.params.mode === "sink")
                    callback()
                else if (error !== undefined)
                    callback(error)
                else {
                    this.push(chunk, encoding)
                    callback()
                }
            },
            final (callback) {
                if (self.closing || self.params.mode === "sink") {
                    callback()
                    return
                }
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
