/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import fs                                  from "node:fs"
import path                                from "node:path"
import Stream                              from "node:stream"
import { Worker }                          from "node:worker_threads"

/*  external dependencies  */
import axios                               from "axios"
import SpeexResampler                      from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for GTCRN based noise suppression in audio-to-audio passing  */
export default class SpeechFlowNodeA2AGTCRN extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-gtcrn"

    /*  internal state  */
    private closing = false
    private worker: Worker | null = null
    private resamplerDown: SpeexResampler | null = null
    private resamplerUp:   SpeexResampler | null = null

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
        this.closing = false

        /*  ensure GTCRN ONNX model is available  */
        const modelUrl  = "https://github.com/k2-fsa/sherpa-onnx/" +
            "releases/download/speech-enhancement-models/gtcrn_simple.onnx"
        const modelDir  = path.join(this.config.cacheDir, "gtcrn")
        const modelPath = path.resolve(modelDir, "gtcrn_simple.onnx")
        const stat = await fs.promises.stat(modelPath).catch(() => null)
        if (stat === null) {
            this.log("info", `GTCRN model downloading from "${modelUrl}"`)
            await fs.promises.mkdir(modelDir, { recursive: true })
            const response = await axios.get(modelUrl, {
                responseType: "arraybuffer",
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const percent = (progressEvent.loaded / progressEvent.total) * 100
                        this.log("info", `GTCRN model download: ${percent.toFixed(1)}%`)
                    }
                }
            })
            await fs.promises.writeFile(modelPath, Buffer.from(response.data))
            this.log("info", `GTCRN model downloaded to "${modelPath}"`)
        }

        /*  establish resamplers from SpeechFlow's internal 48KHz
            to GTCRN's required 16KHz format and back  */
        this.resamplerDown = new SpeexResampler(1, this.config.audioSampleRate, 16000, 7)
        this.resamplerUp   = new SpeexResampler(1, 16000, this.config.audioSampleRate, 7)

        /*  initialize worker  */
        this.worker = new Worker(path.resolve(__dirname, "speechflow-node-a2a-gtcrn-wt.js"), {
            workerData: { modelPath }
        })
        this.worker.on("error", (err) => {
            this.log("error", `GTCRN worker thread error: ${err}`)
            this.stream?.emit("error", err)
        })
        this.worker.on("exit", (code) => {
            if (code !== 0)
                this.log("error", `GTCRN worker thread exited with error code ${code}`)
            else
                this.log("info", `GTCRN worker thread exited with regular code ${code}`)
        })

        /*  wait for worker to be ready  */
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("GTCRN worker thread initialization timeout"))
            }, 60 * 1000)
            const onMessage = (msg: any) => {
                if (typeof msg === "object" && msg !== null && msg.type === "log")
                    this.log(msg.level, msg.message)
                else if (typeof msg === "object" && msg !== null && msg.type === "ready") {
                    clearTimeout(timeout)
                    this.worker!.off("message", onMessage)
                    resolve()
                }
                else if (typeof msg === "object" && msg !== null && msg.type === "failed") {
                    clearTimeout(timeout)
                    this.worker!.off("message", onMessage)
                    reject(new Error(msg.message ?? "GTCRN worker thread initialization failed"))
                }
            }
            this.worker!.on("message", onMessage)
            this.worker!.once("error", (err) => {
                clearTimeout(timeout)
                reject(err)
            })
        })

        /*  receive message from worker  */
        const pending = new Map<string, (arr: Float32Array<ArrayBuffer>) => void>()
        this.worker.on("exit", () => {
            pending.clear()
        })
        this.worker.on("message", (msg: any) => {
            if (typeof msg === "object" && msg !== null && msg.type === "process-done") {
                const cb = pending.get(msg.id)
                pending.delete(msg.id)
                if (cb)
                    cb(msg.data)
                else
                    this.log("warning", `GTCRN worker thread sent back unexpected id: ${msg.id}`)
            }
            else if (typeof msg === "object" && msg !== null && msg.type === "log")
                this.log(msg.level, msg.message)
            else
                this.log("warning", `GTCRN worker thread sent unexpected message: ${JSON.stringify(msg)}`)
        })

        /*  send message to worker  */
        let seq = 0
        const workerProcess = async (samples: Float32Array<ArrayBuffer>) => {
            if (this.closing)
                return samples
            const id = `${seq++}`
            return new Promise<Float32Array<ArrayBuffer>>((resolve) => {
                pending.set(id, (result) => { resolve(result) })
                this.worker!.postMessage({ type: "process", id, samples }, [ samples.buffer ])
            })
        }

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk & { payload: Buffer }, encoding, callback) {
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    /*  resample Buffer from 48KHz (SpeechFlow) to 16KHz (GTCRN)  */
                    const resampledDown = self.resamplerDown!.processChunk(chunk.payload)

                    /*  convert Buffer into Float32Array  */
                    const payload = util.convertBufToF32(resampledDown)

                    /*  process with GTCRN  */
                    workerProcess(payload).then((result: Float32Array<ArrayBuffer>) => {
                        /*  convert Float32Array into Buffer  */
                        const buf = util.convertF32ToBuf(result)

                        /*  resample Buffer from 16KHz (GTCRN) back to 48KHz (SpeechFlow)  */
                        const resampledUp = self.resamplerUp!.processChunk(buf)

                        /*  update chunk  */
                        chunk.payload = resampledUp

                        /*  forward updated chunk  */
                        this.push(chunk)
                        callback()
                    }).catch((err: unknown) => {
                        const error = util.ensureError(err)
                        self.log("warning", `processing of chunk failed: ${error.message}`)
                        callback(error)
                    })
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown worker  */
        if (this.worker !== null) {
            this.worker.terminate()
            this.worker = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  destroy resamplers  */
        if (this.resamplerDown !== null)
            this.resamplerDown = null
        if (this.resamplerUp !== null)
            this.resamplerUp = null
    }
}
