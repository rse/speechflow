/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  the type of muting  */
type MuteMode =
    "none"      |  /*  not muted  */
    "silenced"  |  /*  muted by changing audio samples to silence  */
    "unplugged"    /*  muted by unplugging the audio sample flow   */

/*  SpeechFlow node for muting in audio-to-audio passing  */
export default class SpeechFlowNodeA2AMute extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-mute"

    /*  internal state  */
    private muteMode: MuteMode = "none"
    private destroyed = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({})

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  receive external request  */
    async receiveRequest (params: any[]) {
        if (this.destroyed)
            throw new Error("mute: node already destroyed")
        try {
            if (params.length === 2 && params[0] === "mode") {
                if (typeof params[1] !== "string" ||
                    !params[1].match(/^(?:none|silenced|unplugged)$/))
                    throw new Error("mute: invalid mode argument in external request")
                const muteMode = params[1] as MuteMode
                this.setMuteMode(muteMode)
                this.sendResponse([ "mute", "mode", muteMode ])
            }
            else
                throw new Error("mute: invalid arguments in external request")
        }
        catch (error) {
            this.log("error", `receive request error: ${error}`)
            throw error
        }
    }

    /*  change mute mode  */
    setMuteMode (mode: MuteMode) {
        if (this.destroyed) {
            this.log("warning", "attempted to set mute mode on destroyed node")
            return
        }
        this.log("info", `setting mute mode to "${mode}"`)
        this.muteMode = mode
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (self.muteMode === "unplugged")
                    /*  pass-through nothing  */
                    callback()
                else if (self.muteMode === "silenced") {
                    /*  pass-through a silenced chunk  */
                    const chunkSilenced = chunk.clone()
                    chunkSilenced.meta.set("muted", true)
                    const buffer = chunkSilenced.payload as Buffer
                    buffer.fill(0)
                    this.push(chunkSilenced)
                    callback()
                }
                else {
                    /*  pass-through original chunk  */
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

