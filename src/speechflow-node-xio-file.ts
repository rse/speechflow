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
import * as utils       from "./speechflow-utils"

/*  SpeechFlow node for file access  */
export default class SpeechFlowNodeFile extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "file"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            path: { type: "string", pos: 0, val: "" },
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
        if (this.params.path === "")
            throw new Error("required parameter \"path\" has to be given")
        if (this.params.mode === "rw") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                if (this.params.type === "audio") {
                    process.stdin.setEncoding()
                    process.stdout.setEncoding()
                }
                else {
                    process.stdin.setEncoding(this.config.textEncoding)
                    process.stdout.setEncoding(this.config.textEncoding)
                }
                this.stream = Stream.Duplex.from({
                    readable: process.stdin,
                    writable: process.stdout
                })
            }
            else {
                /*  file I/O  */
                if (this.params.type === "audio") {
                    this.stream = Stream.Duplex.from({
                        readable: fs.createReadStream(this.params.path),
                        writable: fs.createWriteStream(this.params.path)
                    })
                }
                else {
                    this.stream = Stream.Duplex.from({
                        readable: fs.createReadStream(this.params.path,
                            { encoding: this.config.textEncoding }),
                        writable: fs.createWriteStream(this.params.path,
                            { encoding: this.config.textEncoding })
                    })
                }
            }

            /*  convert regular stream into object-mode stream  */
            const wrapper1 = utils.createTransformStreamForWritableSide()
            const wrapper2 = utils.createTransformStreamForReadableSide(this.params.type, () => this.timeZero)
            this.stream = Stream.compose(wrapper1, this.stream, wrapper2)
        }
        else if (this.params.mode === "r") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                if (this.params.type === "audio")
                    process.stdin.setEncoding()
                else
                    process.stdin.setEncoding(this.config.textEncoding)
                this.stream = process.stdin
            }
            else {
                /*  file I/O  */
                if (this.params.type === "audio")
                    this.stream = fs.createReadStream(this.params.path)
                else
                    this.stream = fs.createReadStream(this.params.path,
                        { encoding: this.config.textEncoding })
            }

            /*  convert regular stream into object-mode stream  */
            const wrapper = utils.createTransformStreamForReadableSide(this.params.type, () => this.timeZero)
            this.stream.pipe(wrapper)
            this.stream = wrapper
        }
        else if (this.params.mode === "w") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                if (this.params.type === "audio")
                    process.stdout.setEncoding()
                else
                    process.stdout.setEncoding(this.config.textEncoding)
                this.stream = process.stdout
            }
            else {
                /*  file I/O  */
                if (this.params.type === "audio")
                    this.stream = fs.createWriteStream(this.params.path)
                else
                    this.stream = fs.createWriteStream(this.params.path,
                        { encoding: this.config.textEncoding })
            }

            /*  convert regular stream into object-mode stream  */
            const wrapper = utils.createTransformStreamForWritableSide()
            wrapper.pipe(this.stream as Stream.Writable)
            this.stream = wrapper
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

