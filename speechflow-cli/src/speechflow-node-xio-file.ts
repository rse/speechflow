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
export default class SpeechFlowNodeXIOFile extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-file"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            path:   { type: "string", pos: 0, val: "" },
            mode:   { type: "string", pos: 1, val: "r",     match: /^(?:r|w|rw)$/ },
            type:   { type: "string", pos: 2, val: "audio", match: /^(?:audio|text)$/ },
            chunka: { type: "number",         val: 200,     match: (n: number) => n >= 10 && n <= 1000 },
            chunkt: { type: "number",         val: 65536,   match: (n: number) => n >= 1024 && n <= 131072 }
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
        /*  determine how many bytes we need per chunk when
            the chunk should be of the required duration/size */
        const highWaterMarkAudio = (
            this.config.audioSampleRate *
            (this.config.audioBitDepth / 8)
        ) / (1000 / this.params.chunka)
        const highWaterMarkText = this.params.chunkt

        /*  sanity check  */
        if (this.params.path === "")
            throw new Error("required parameter \"path\" has to be given")

        /*  dispatch according to mode and path  */
        if (this.params.mode === "rw") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                if (this.params.type === "audio") {
                    process.stdin.setEncoding()
                    process.stdout.setEncoding()
                    const streamR = new Stream.PassThrough({ highWaterMark: highWaterMarkAudio })
                    process.stdin.pipe(streamR)
                    const streamW = new Stream.PassThrough({ highWaterMark: highWaterMarkAudio })
                    streamW.pipe(process.stdout)
                    this.stream = Stream.Duplex.from({ readable: streamR, writable: streamW })
                }
                else {
                    process.stdin.setEncoding(this.config.textEncoding)
                    process.stdout.setEncoding(this.config.textEncoding)
                    const streamR = new Stream.PassThrough({ highWaterMark: highWaterMarkText })
                    process.stdin.pipe(streamR)
                    const streamW = new Stream.PassThrough({ highWaterMark: highWaterMarkText })
                    streamW.pipe(process.stdout)
                    this.stream = Stream.Duplex.from({ readable: streamR, writable: streamW })
                }
            }
            else {
                /*  file I/O  */
                if (this.params.type === "audio") {
                    this.stream = Stream.Duplex.from({
                        readable: fs.createReadStream(this.params.path,
                            { highWaterMark: highWaterMarkAudio }),
                        writable: fs.createWriteStream(this.params.path,
                            { highWaterMark: highWaterMarkAudio })
                    })
                }
                else {
                    this.stream = Stream.Duplex.from({
                        readable: fs.createReadStream(this.params.path, {
                            highWaterMark: highWaterMarkText,
                            encoding: this.config.textEncoding
                        }),
                        writable: fs.createWriteStream(this.params.path, {
                            highWaterMark: highWaterMarkText,
                            encoding: this.config.textEncoding
                        })
                    })
                }
            }

            /*  convert regular stream into object-mode stream  */
            const wrapper1 = utils.createTransformStreamForWritableSide()
            const wrapper2 = utils.createTransformStreamForReadableSide(
                this.params.type, () => this.timeZero)
            this.stream = Stream.compose(wrapper1, this.stream, wrapper2)
        }
        else if (this.params.mode === "r") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                let chunker: Stream.PassThrough
                if (this.params.type === "audio") {
                    process.stdin.setEncoding()
                    chunker = new Stream.PassThrough({ highWaterMark: highWaterMarkAudio })
                }
                else {
                    process.stdin.setEncoding(this.config.textEncoding)
                    chunker = new Stream.PassThrough({ highWaterMark: highWaterMarkText })
                }
                const wrapper = utils.createTransformStreamForReadableSide(
                    this.params.type, () => this.timeZero)
                this.stream = Stream.compose(process.stdin, chunker, wrapper)
            }
            else {
                /*  file I/O  */
                let readable: Stream.Readable
                if (this.params.type === "audio")
                    readable = fs.createReadStream(this.params.path,
                        { highWaterMark: highWaterMarkAudio })
                else
                    readable = fs.createReadStream(this.params.path,
                        { highWaterMark: highWaterMarkText, encoding: this.config.textEncoding })
                const wrapper = utils.createTransformStreamForReadableSide(
                    this.params.type, () => this.timeZero)
                this.stream = Stream.compose(readable, wrapper)
            }
        }
        else if (this.params.mode === "w") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                let chunker: Stream.PassThrough
                if (this.params.type === "audio") {
                    process.stdout.setEncoding()
                    chunker = new Stream.PassThrough({ highWaterMark: highWaterMarkAudio })
                }
                else {
                    process.stdout.setEncoding(this.config.textEncoding)
                    chunker = new Stream.PassThrough({ highWaterMark: highWaterMarkText })
                }
                const wrapper = utils.createTransformStreamForWritableSide()
                this.stream = Stream.compose(wrapper, chunker, process.stdout)
            }
            else {
                /*  file I/O  */
                let writable: Stream.Writable
                if (this.params.type === "audio")
                    writable = fs.createWriteStream(this.params.path,
                        { highWaterMark: highWaterMarkAudio })
                else
                    writable = fs.createWriteStream(this.params.path,
                        { highWaterMark: highWaterMarkText, encoding: this.config.textEncoding })
                const wrapper = utils.createTransformStreamForWritableSide()
                this.stream = Stream.compose(wrapper, writable)
            }
        }
        else
            throw new Error(`invalid file mode "${this.params.mode}"`)
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await Promise.race([
                new Promise<void>((resolve, reject) => {
                    if (this.stream instanceof Stream.Writable || this.stream instanceof Stream.Duplex) {
                        this.stream.end((err?: Error) => {
                            if (err)
                                reject(err)
                            else
                                resolve()
                        })
                    }
                    else
                        resolve()
                }),
                new Promise<void>((resolve) => setTimeout(() => resolve(), 5000))
            ])
            if (this.params.path !== "-")
                this.stream.destroy()
            this.stream = null
        }
    }
}

