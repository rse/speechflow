/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream               from "node:stream"
import { Worker }           from "node:worker_threads"
import { resolve }          from "node:path"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for RNNoise based noise suppression in audio-to-audio passing  */
export default class SpeechFlowNodeRNNoise extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "rnnoise"

    /*  internal state  */
    private destroyed = false
    private static speexInitialized = false
    private sampleSize = 480 /* = 10ms at 48KHz, as required by RNNoise! */
    private worker: Worker | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            threshold: { type: "number", val: -42, match: (n: number) => n <= 0 && n >= -60 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  initialize worker  */
        this.worker = new Worker(resolve(__dirname, "speechflow-node-a2a-rnnoise-wt.js"))
        this.worker.on("error", (err) => {
            this.log("error", `rnnoise worker thread error: ${err}`)
        })
        this.worker.on("exit", (code) => {
            if (code !== 0)
                this.log("error", `rnnoise worker thread exited with error code ${code}`)
            else
                this.log("info", `rnnoise worker thread exited with regular code ${code}`)
        })
        await new Promise<void>((resolve, reject) => {
            this.worker!.once("message", (msg: any) => {
                if (typeof msg === "object" && msg !== null && msg.type === "ready")
                    resolve()
                else
                    reject(new Error(`rnnoise worker thread sent unexpected message on startup`))
            })
        })

        /*  receive message from worker  */
        const pending = new Map<string, (arr: Int16Array<ArrayBuffer>) => void>()
        this.worker.on("message", (msg: any) => {
            if (typeof msg === "object" && msg !== null && msg.type === "process-done") {
                const cb = pending.get(msg.id)
                pending.delete(msg.id)
                if (cb)
                    cb(msg.data)
                else
                    this.log("warning", `rnnoise worker thread sent back unexpected id: ${msg.id}`)
            }
            else
                this.log("warning", `rnnoise worker thread send unexpected message: ${JSON.stringify(msg)}`)
        })

        /*  send message to worker  */
        let seq = 0
        const workerProcessSegment = async (segment: Int16Array<ArrayBuffer>) => {
            if (this.destroyed)
                return segment
            const id = `${seq++}`
            return new Promise<Int16Array<ArrayBuffer>>((resolve) => {
                pending.set(id, (segment: Int16Array<ArrayBuffer>) => { resolve(segment) })
                this.worker!.postMessage({ type: "process", id, data: segment }, [ segment.buffer ])
            })
        }

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk & { payload: Buffer }, encoding, callback) {
                if (self.destroyed) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    /*  convert Buffer into Int16Array  */
                    const payload = utils.convertBufToI16(chunk.payload)

                    /*  process Int16Array in necessary segments  */
                    utils.processInt16ArrayInSegments(payload, self.sampleSize, (segment) => {
                        return workerProcessSegment(segment)
                    }).then((payload: Int16Array<ArrayBuffer>) => {
                        /*  convert Int16Array into Buffer  */
                        const buf = utils.convertI16ToBuf(payload)

                        /*  update chunk  */
                        chunk.payload = buf

                        /*  forward updated chunk  */
                        this.push(chunk)
                        callback()
                    })
                }
            },
            final (callback) {
                if (self.destroyed) {
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
        /*  indicate destruction  */
        this.destroyed = true

        /*  shutdown worker  */
        if (this.worker !== null) {
            this.worker.terminate()
            this.worker = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
