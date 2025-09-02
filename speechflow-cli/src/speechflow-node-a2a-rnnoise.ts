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
export default class SpeechFlowNodeA2ARNNoise extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-rnnoise"

    /*  internal state  */
    private destroyed = false
    private sampleSize = 480 /* = 10ms at 48KHz, as required by RNNoise! */
    private worker: Worker | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({})

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
            this.log("error", `RNNoise worker thread error: ${err}`)
        })
        this.worker.on("exit", (code) => {
            if (code !== 0)
                this.log("error", `RNNoise worker thread exited with error code ${code}`)
            else
                this.log("info", `RNNoise worker thread exited with regular code ${code}`)
        })
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("RNNoise worker thread initialization timeout"))
            }, 5000)
            this.worker!.once("message", (msg: any) => {
                clearTimeout(timeout)
                if (typeof msg === "object" && msg !== null && msg.type === "ready")
                    resolve()
                else if (typeof msg === "object" && msg !== null && msg.type === "failed")
                    reject(new Error(msg.message ?? "RNNoise worker thread initialization failed"))
                else
                    reject(new Error(`RNNoise worker thread sent unexpected message on startup`))
            })
            this.worker!.once("error", (err) => {
                clearTimeout(timeout)
                reject(err)
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
                    this.log("warning", `RNNoise worker thread sent back unexpected id: ${msg.id}`)
            }
            else
                this.log("warning", `RNNoise worker thread sent unexpected message: ${JSON.stringify(msg)}`)
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
                    utils.processInt16ArrayInSegments(payload, self.sampleSize, (segment) =>
                        workerProcessSegment(segment)
                    ).then((payload: Int16Array<ArrayBuffer>) => {
                        /*  convert Int16Array into Buffer  */
                        const buf = utils.convertI16ToBuf(payload)

                        /*  update chunk  */
                        chunk.payload = buf

                        /*  forward updated chunk  */
                        this.push(chunk)
                        callback()
                    }).catch((err: Error) => {
                        self.log("warning", `processing of chunk failed: ${err}`)
                        callback(err)
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
