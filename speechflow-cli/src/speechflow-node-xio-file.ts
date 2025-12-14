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
import * as util        from "./speechflow-util"

/*  SpeechFlow node for file access  */
export default class SpeechFlowNodeXIOFile extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-file"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            path:       { type: "string", pos: 0, val: "" },
            mode:       { type: "string", pos: 1, val: "r",     match: /^(?:r|w)$/ },
            type:       { type: "string", pos: 2, val: "audio", match: /^(?:audio|text)$/ },
            chunkAudio: { type: "number",         val: 200,     match: (n: number) => n >= 10 && n <= 1000 },
            chunkText:  { type: "number",         val: 65536,   match: (n: number) => n >= 1024 && n <= 131072 }
        })

        /*  sanity check parameters  */
        if (this.params.path === "")
            throw new Error("required parameter \"path\" has to be given")

        /*  declare node input/output format  */
        if (this.params.mode === "r") {
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
        ) / (1000 / this.params.chunkAudio)
        const highWaterMarkText = this.params.chunkText

        /*  utility function: create a writable stream as chunker that
            writes to process.stdout but properly handles finish events.
            This ensures the writable side of the composed stream below
            properly signals completion while keeping process.stdout open
            (as it's a global stream that shouldn't be closed by individual nodes). */
        const createStdoutChunker = () =>
            new Stream.Writable({
                highWaterMark: this.params.type === "audio" ?
                    highWaterMarkAudio : highWaterMarkText,
                write (chunk: Buffer | string, encoding, callback) {
                    const canContinue = process.stdout.write(chunk, encoding)
                    if (canContinue)
                        callback()
                    else
                        process.stdout.once("drain", callback)
                },
                final (callback) {
                    callback()
                }
            })

        /*  dispatch according to mode and path  */
        if (this.params.mode === "r") {
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
                const wrapper = util.createTransformStreamForReadableSide(
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
                const wrapper = util.createTransformStreamForReadableSide(
                    this.params.type, () => this.timeZero)
                this.stream = Stream.compose(readable, wrapper)
            }
        }
        else if (this.params.mode === "w") {
            if (this.params.path === "-") {
                /*  standard I/O  */
                if (this.params.type === "audio")
                    process.stdout.setEncoding()
                else
                    process.stdout.setEncoding(this.config.textEncoding)
                const chunker = createStdoutChunker()
                const wrapper = util.createTransformStreamForWritableSide(this.params.type, 1)
                this.stream = Stream.compose(wrapper, chunker)
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
                const wrapper = util.createTransformStreamForWritableSide(this.params.type, 1)
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
            /*  only destroy non-stdio streams  */
            if (this.params.path !== "-")
                await util.destroyStream(this.stream)
            else {
                /*  for stdio streams, just end without destroying  */
                const stream = this.stream
                if ((stream instanceof Stream.Writable || stream instanceof Stream.Duplex) &&
                    (!stream.writableEnded && !stream.destroyed)                             ) {
                    await Promise.race([
                        new Promise<void>((resolve, reject) => {
                            stream.end((err?: Error) => {
                                if (err) reject(err)
                                else     resolve()
                            })
                        }),
                        util.timeout(5000)
                    ])
                }
            }
            this.stream = null
        }
    }
}

