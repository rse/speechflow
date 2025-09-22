/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path                 from "node:path"
import fs                   from "node:fs"
import Stream               from "node:stream"

/*  external dependencies  */
import { loadSpeexModule, SpeexPreprocessor } from "@sapphi-red/speex-preprocess-wasm"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Speex based noise suppression in audio-to-audio passing  */
export default class SpeechFlowNodeA2ASpeex extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-speex"

    /*  internal state  */
    private destroyed = false
    private sampleSize = 480 /* = 10ms at 48KHz */
    private speexProcessor: SpeexPreprocessor | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            attenuate: { type: "number", val: -18, pos: 0, match: (n: number) => n >= -60 && n <= 0 },
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  validate sample rate compatibility  */
        if (this.config.audioSampleRate !== 48000)
            throw new Error(`Speex node requires 48KHz sample rate, got ${this.config.audioSampleRate}Hz`)

        /*  initialize and configure Speex pre-processor  */
        const wasmBinary = await fs.promises.readFile(
            path.join(__dirname, "../node_modules/@sapphi-red/speex-preprocess-wasm/dist/speex.wasm"))
        const speexModule = await loadSpeexModule({
            wasmBinary: wasmBinary.buffer as ArrayBuffer
        })
        this.speexProcessor = new SpeexPreprocessor(
            speexModule, this.sampleSize, this.config.audioSampleRate)
        this.speexProcessor.denoise            = true
        this.speexProcessor.noiseSuppress      = this.params.attenuate
        this.speexProcessor.agc                = false
        this.speexProcessor.vad                = false
        this.speexProcessor.echoSuppress       = 0
        this.speexProcessor.echoSuppressActive = 0

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
                    const payload = util.convertBufToI16(chunk.payload)

                    /*  process Int16Array in necessary fixed-size segments  */
                    util.processInt16ArrayInSegments(payload, self.sampleSize, (segment) => {
                        if (self.destroyed)
                            throw new Error("stream already destroyed")
                        self.speexProcessor?.processInt16(segment)
                        return Promise.resolve(segment)
                    }).then((payload: Int16Array<ArrayBuffer>) => {
                        if (self.destroyed)
                            throw new Error("stream already destroyed")

                        /*  convert Int16Array back into Buffer  */
                        const buf = util.convertI16ToBuf(payload)

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

        /*  destroy processor  */
        if (this.speexProcessor !== null) {
            this.speexProcessor.destroy()
            this.speexProcessor = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
