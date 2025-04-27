/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import fs               from "node:fs"
import Stream           from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  SpeechFlow node for file access  */
export default class SpeechFlowNodeFile extends SpeechFlowNode {
    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            path: { type: "string", pos: 0 },
            mode: { type: "string", pos: 1, val: "r",     match: /^(?:r|w|rw)$/ },
            type: { type: "string", pos: 2, val: "audio", match: /^(?:audio|text)$/ }
        })

        /*  declare node input/output format  */
        if (this.params.mode === "rw") {
            this.input  = this.params.type
            this.output = this.params.type
        }
        else if (this.params.mode === "r") {
            this.input  = "none"
            this.output = this.params.type
        }
        else if (this.params.mode === "w") {
            this.input  = this.params.type
            this.output = "none"
        }
    }

    /*  open node  */
    async open () {
        const encoding = this.params.type === "text" ? this.config.textEncoding : "binary"
        if (this.params.mode === "rw") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                process.stdin.setEncoding(encoding)
                process.stdout.setEncoding(encoding)
                this.stream = Stream.Duplex.from({
                    readable: process.stdin,
                    writable: process.stdout
                })
            }
            else {
                /*  file I/O  */
                this.stream = Stream.Duplex.from({
                    readable: fs.createReadStream(this.params.path, { encoding }),
                    writable: fs.createWriteStream(this.params.path, { encoding })
                })
            }
        }
        else if (this.params.mode === "r") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                process.stdin.setEncoding(encoding)
                this.stream = process.stdin
            }
            else {
                /*  file I/O  */
                this.stream = fs.createReadStream(this.params.path, { encoding })
            }
        }
        else if (this.params.mode === "w") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                process.stdout.setEncoding(encoding)
                this.stream = process.stdout
            }
            else {
                /*  file I/O  */
                this.stream = fs.createWriteStream(this.params.path, { encoding })
            }
        }
        else
            throw new Error(`invalid file mode "${this.params.mode}"`)
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await new Promise<void>((resolve) => {
                if (this.stream instanceof Stream.Writable || this.stream instanceof Stream.Duplex)
                    this.stream.end(() => { resolve() })
                else
                    resolve()
            })
            if (this.params.path !== "-")
                this.stream.destroy()
            this.stream = null
        }
    }
}

