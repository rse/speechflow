/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Events from "node:events"
import Stream from "node:stream"
import { DateTime, Duration } from "luxon"

/*  the definition of a single payload chunk passed through the SpeechFlow nodes  */
export class SpeechFlowChunk {
    constructor (
        public timestampStart: Duration,
        public timestampEnd:   Duration,
        public kind:           "intermediate" | "final",
        public type:           "audio" | "text",
        public payload:        Buffer | string
    ) {}
    clone () {
        let payload: Buffer | string
        if (Buffer.isBuffer(this.payload))
            payload = Buffer.from(this.payload)
        else
            payload = String(this.payload)
        return new SpeechFlowChunk(
            Duration.fromMillis(this.timestampStart.toMillis()),
            Duration.fromMillis(this.timestampEnd.toMillis()),
            this.kind,
            this.type,
            payload
        )
    }
}

/*  the base class for all SpeechFlow nodes  */
export default class SpeechFlowNode extends Events.EventEmitter {
    /*  general constant configuration (for reference)  */
    config = {
        audioChannels:     1,                            /* audio mono channel        */
        audioBitDepth:     16 as (1 | 8 | 16 | 24 | 32), /* audio PCM 16-bit integer  */
        audioLittleEndian: true,                         /* audio PCM little-endian   */
        audioSampleRate:   48000,                        /* audio 48kHz sample rate   */
        textEncoding:      "utf8" as BufferEncoding,     /* UTF-8 text encoding       */
        cacheDir:          ""                            /* directory for cache files */
    }

    /*  announced information  */
    input  = "none"
    output = "none"
    params: { [ id: string ]: any } = {}
    stream: Stream.Writable | Stream.Readable | Stream.Duplex | null = null
    connectionsIn  = new Set<SpeechFlowNode>()
    connectionsOut = new Set<SpeechFlowNode>()
    timeOpen:       DateTime<boolean> | undefined
    timeZero:       DateTime<boolean> = DateTime.fromMillis(0)
    timeZeroOffset: Duration<boolean> = Duration.fromMillis(0)

    /*  the default constructor  */
    constructor (
        public  id:   string,
        private cfg:  { [ id: string ]: any },
        private opts: { [ id: string ]: any },
        private args: any[]
    ) {
        super()
        for (const key of Object.keys(cfg)) {
            const idx = key as keyof typeof this.config
            if (this.config[idx] !== undefined)
                (this.config[idx] as any) = cfg[key]
        }
    }

    /*  set base/zero time for relative timestamp calculations  */
    setTimeZero (time: DateTime) {
        this.timeZero = time
        if (this.timeOpen === undefined)
            this.timeOpen = this.timeZero
        this.timeZeroOffset = this.timeZero.diff(this.timeOpen)
    }

    /*  INTERNAL: utility function: create "params" attribute from constructor of sub-classes  */
    configure (spec: { [ id: string ]: { type: string, pos?: number, val?: any, match?: RegExp | ((x: any) => boolean) } }) {
        for (const name of Object.keys(spec)) {
            if (this.opts[name] !== undefined) {
                /*  named parameter  */
                if (typeof this.opts[name] !== spec[name].type)
                    throw new Error(`invalid type of named parameter "${name}" ` +
                        `(has to be ${spec[name].type})`)
                if ("match" in spec[name]
                    && (   (   spec[name].match instanceof RegExp
                            && this.opts[name].match(spec[name].match) === null)
                        || (   typeof spec[name].match === "function"
                            && !spec[name].match(this.opts[name])    )          ))
                    throw new Error(`invalid value "${this.opts[name]}" of named parameter "${name}"`)
                this.params[name] = this.opts[name]
            }
            else if (this.opts[name] === undefined
                && "pos" in spec[name]
                && typeof spec[name].pos === "number"
                && spec[name].pos < this.args.length) {
                /*  positional argument  */
                if (typeof this.args[spec[name].pos] !== spec[name].type)
                    throw new Error(`invalid type of positional parameter "${name}" ` +
                        `(has to be ${spec[name].type})`)
                if ("match" in spec[name]
                    && this.args[spec[name].pos].match(spec[name].match) === null)
                    throw new Error(`invalid value of positional parameter "${name}" ` +
                        `(has to match ${spec[name].match})`)
                if ("match" in spec[name]
                    && (   (   spec[name].match instanceof RegExp
                            && this.args[spec[name].pos].match(spec[name].match) === null)
                        || (   typeof spec[name].match === "function"
                            && !spec[name].match(this.args[spec[name].pos])    )          ))
                    throw new Error(`invalid value "${this.opts[name]}" of positional parameter "${name}"`)
                this.params[name] = this.args[spec[name].pos]
            }
            else if ("val" in spec[name] && spec[name].val !== undefined)
                /*  default argument  */
                this.params[name] = spec[name].val
            else
                throw new Error(`required parameter "${name}" not given`)
        }
        for (const name of Object.keys(this.opts)) {
            if (spec[name] === undefined)
                throw new Error(`named parameter "${name}" not known`)
        }
        for (let i = 0; i < this.args.length; i++) {
            let found = false
            for (const name of Object.keys(spec))
                if (spec[name].pos === i)
                    found = true
            if (!found)
                throw new Error(`positional parameter #${i} ("${this.args[i]}") ` +
                    "not mappable to any known argument")
        }
    }

    /*  connect node to another one  */
    connect (other: SpeechFlowNode) {
        this.connectionsOut.add(other)
        other.connectionsIn.add(this)
    }

    /*  disconnect node from another one  */
    disconnect (other: SpeechFlowNode) {
        if (!this.connectionsOut.has(other))
            throw new Error("invalid node: not connected to this node")
        this.connectionsOut.delete(other)
        other.connectionsIn.delete(this)
    }

    /*  internal log function  */
    log (level: string, msg: string, data?: any) {
        this.emit("log", level, msg, data)
    }

    /*  default implementation for open/close operations  */
    async open  () {}
    async close () {}
}

