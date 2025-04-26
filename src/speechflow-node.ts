/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Events  from "node:events"
import Stream  from "node:stream"

export default class SpeechFlowNode extends Events.EventEmitter {
    public config = {
        audioChannels:     1,      /* audio mono channel       */
        audioBitDepth:     16,     /* audio PCM 16-bit integer */
        audioLittleEndian: true,   /* audio PCM little-endian  */
        audioSampleRate:   48000,  /* audio 48kHz sample rate  */
        textEncoding:      "utf8"  /* UTF-8 text encoding      */
    } as const
    public input  = "none"
    public output = "none"
    public params = {} as { [ id: string ]: any }
    public stream: Stream.Writable | Stream.Readable | Stream.Duplex | null = null

    public connectionsIn  = new Set<SpeechFlowNode>()
    public connectionsOut = new Set<SpeechFlowNode>()

    constructor (
        public id: string,
        private opts: { [ id: string ]: any },
        private args: any[]
    ) {
        super()
    }

    configure (spec: { [ id: string ]: { type: string, pos?: number, val?: any, match?: RegExp } }) {
        for (const name of Object.keys(spec)) {
            if (this.opts[name] !== undefined) {
                if (typeof this.opts[name] !== spec[name].type)
                    throw new Error(`invalid type of option "${name}"`)
                if ("match" in spec[name] && this.opts[name].match(spec[name].match) === null)
                    throw new Error(`invalid value of option "${name}" (has to match ${spec[name].match})`)
                this.params[name] = this.opts[name]
            }
            else if (this.opts[name] === undefined
                && "pos" in spec[name]
                && spec[name].pos! < this.args.length) {
                if (typeof this.args[spec[name].pos!] !== spec[name].type)
                    throw new Error(`invalid type of argument "${name}"`)
                if ("match" in spec[name] && this.args[spec[name].pos!].match(spec[name].match) === null)
                    throw new Error(`invalid value of option "${name}" (has to match ${spec[name].match})`)
                this.params[name] = this.args[spec[name].pos!]
            }
            else if ("val" in spec[name] && spec[name].val !== undefined)
                this.params[name] = spec[name].val
            else
                throw new Error(`required parameter "${name}" not given`)
        }
    }
    connect (other: SpeechFlowNode) {
        this.connectionsOut.add(other)
        other.connectionsIn.add(this)
    }
    disconnect (other: SpeechFlowNode) {
        if (!this.connectionsOut.has(other))
            throw new Error("invalid node: not connected to this node")
        this.connectionsOut.delete(other)
        other.connectionsIn.delete(this)
    }
    log (level: string, msg: string, data?: any) {
        this.emit("log", level, msg, data)
    }
    async open () {
    }
    async close () {
    }
}

