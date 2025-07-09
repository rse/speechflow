/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  external dependencies  */
import wav              from "wav"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  utility class for wrapping a custom stream into a regular Transform stream  */
class StreamWrapper extends Stream.Transform {
    private foreignStream: any
    constructor (foreignStream: any, options: Stream.TransformOptions = {}) {
        options.readableObjectMode = true
        options.writableObjectMode = true
        super(options)
        this.foreignStream = foreignStream
        this.foreignStream.on("data", (chunk: any) => {
            this.push(chunk)
        })
        this.foreignStream.on("error", (err: Error) => {
            this.emit("error", err)
        })
        this.foreignStream.on("end", () => {
            this.push(null)
        })
    }
    _transform (chunk: any, encoding: BufferEncoding, callback: Stream.TransformCallback): void {
        try {
            const canContinue = this.foreignStream.write(chunk)
            if (canContinue)
                callback()
            else
                this.foreignStream.once("drain", callback)
        }
        catch (err) {
            callback(err as Error)
        }
    }
    _flush (callback: Stream.TransformCallback): void {
        try {
            if (typeof this.foreignStream.end === "function")
                this.foreignStream.end()
            callback()
        }
        catch (err) {
            callback(err as Error)
        }
    }
}

/*  SpeechFlow node for WAV format conversion  */
export default class SpeechFlowNodeWAV extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "wav"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            mode: { type: "string", pos: 1, val: "encode", match: /^(?:encode|decode)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        if (this.params.mode === "encode") {
            /*  convert raw/PCM to WAV/PCM  */
            /*  NOTICE: as this is a continuous stream, the resulting WAV header is not 100%
                conforming to the WAV standard, as it has to use a zero duration information.
                This cannot be changed in a stream-based processing.  */
            const writer = new wav.Writer({
                format:     0x0001 /* PCM */,
                channels:   this.config.audioChannels,
                sampleRate: this.config.audioSampleRate,
                bitDepth:   this.config.audioBitDepth
            })
            this.stream = new StreamWrapper(writer)
        }
        else if (this.params.mode === "decode") {
            /*  convert WAV/PCM to raw/PCM  */
            const reader = new wav.Reader()
            reader.on("format", (format: any) => {
                this.log("info", `WAV audio stream: format=${format.audioFormat === 0x0001 ? "PCM" :
                    "0x" + (format.audioFormat as number).toString(16).padStart(4, "0")} ` +
                    `bitDepth=${format.bitDepth} ` +
                    `signed=${format.signed ? "yes" : "no"} ` +
                    `endian=${format.endianness} ` +
                    `sampleRate=${format.sampleRate} ` +
                    `channels=${format.channels}`)
                if (format.audioFormat !== 0x0001 /* PCM */)
                    throw new Error("WAV not based on PCM format")
                if (format.bitDepth !== 16)
                    throw new Error("WAV not based on 16 bit samples")
                if (!format.signed)
                    throw new Error("WAV not based on signed integers")
                if (format.endianness !== "LE")
                    throw new Error("WAV not based on little endianness")
                if (format.sampleRate !== 48000)
                    throw new Error("WAV not based on 48Khz sample rate")
                if (format.channels !== 1)
                    throw new Error("WAV not based on mono channel")
            })
            this.stream = new StreamWrapper(reader)
        }
        else
            throw new Error(`invalid operation mode "${this.params.mode}"`)
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await new Promise<void>((resolve) => {
                if (this.stream instanceof Stream.Transform)
                    this.stream.end(() => { resolve() })
            })
            this.stream.destroy()
            this.stream = null
        }
    }
}

