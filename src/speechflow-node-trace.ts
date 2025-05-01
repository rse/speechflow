/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { EventEmitter } from "node:events"
import Stream           from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  SpeechFlow node for data flow tracing  */
export default class SpeechFlowNodeTrace extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "trace"

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            type: { type: "string", pos: 0, val: "audio", match: /^(?:audio|text)$/ },
            name: { type: "string", pos: 1 }
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
                this.log(level, `<${this.params.name}>: ${msg}`)
            else
                this.log(level, msg)
        }

        /*  internal queue for data chunks  */
        const queue = new EventEmitter()

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const type = this.params.type
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            write (chunk: Buffer | string, encoding, callback) {
                let error: Error | undefined
                if (Buffer.isBuffer(chunk)) {
                    if (type === "audio")
                        log("info", `writing ${type} chunk: type=Buffer bytes=${chunk.byteLength}`)
                    else {
                        console.log("FUCK", chunk, chunk.toString())
                        error = new Error(`writing ${type} chunk: seen Buffer instead of String chunk type`)
                    }
                }
                else {
                    if (type === "text")
                        log("info", `writing ${type} chunk: type=String length=${chunk.length} ` +
                            `encoding=${encoding} payload="${chunk.toString()}"`)
                    else
                        error = new Error(`writing ${type} chunk: seen String instead of Buffer chunk type`)
                }
                if (error !== undefined)
                    callback(error)
                else {
                    queue.emit("result", { chunk, encoding })
                    callback()
                }
            },
            read (size) {
                queue.once("result", (data: { chunk: Buffer | string, encoding: BufferEncoding }) => {
                    this.push(data.chunk, data.encoding)
                })
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
