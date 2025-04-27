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
                this.log(level, `<${this.params.name}>: ${this.params.type}: ${msg}`)
            else
                this.log(level, `${this.params.type}: ${msg}`)
        }

        /*  internal queue for data chunks  */
        const queue = new EventEmitter()

        /*  provide Duplex stream and internally attach to Deepgram API  */
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding, callback) {
                log("info", `write chunk: bytes=${chunk.byteLength} encoding=${encoding}`)
                queue.emit("result", chunk)
                callback()
            },
            read (size) {
                queue.once("result", (chunk: Buffer) => {
                    this.push(chunk)
                })
            },
            final (callback) {
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
