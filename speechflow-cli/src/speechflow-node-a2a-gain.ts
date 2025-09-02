/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for gain adjustment in audio-to-audio passing  */
export default class SpeechFlowNodeA2AGain extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-gain"

    /*  internal state  */
    private destroyed = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            db: { type: "number", val: 0, pos: 0, match: (n: number) => n >= -60 && n <= 60 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  adjust gain  */
        const adjustGain = (chunk: SpeechFlowChunk & { payload: Buffer }, db: number) => {
            const dv = new DataView(chunk.payload.buffer, chunk.payload.byteOffset, chunk.payload.byteLength)
            const gainFactor = utils.dB2lin(db)
            for (let i = 0; i < dv.byteLength; i += 2) {
                let sample = dv.getInt16(i, true)
                sample *= gainFactor
                sample = Math.max(Math.min(sample, 32767), -32768)
                dv.setInt16(i, sample, true)
            }
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
                else if (chunk.payload.byteLength % 2 !== 0)
                    callback(new Error("invalid audio buffer size (not 16-bit aligned)"))
                else {
                    /*  adjust chunk  */
                    adjustGain(chunk, self.params.db)
                    this.push(chunk)
                    callback()
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

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}

