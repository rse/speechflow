/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { DateTime, Duration } from "luxon"
import * as CBOR              from "cbor2"

/*  internal dependencies  */
import { SpeechFlowChunk }    from "./speechflow-node"
import { audioBufferDuration } from "./speechflow-utils-audio"

/*  create a Duplex/Transform stream which has
    object-mode on Writable side and buffer/string-mode on Readable side  */
export function createTransformStreamForWritableSide () {
    return new Stream.Transform({
        readableObjectMode: true,
        writableObjectMode: true,
        decodeStrings: false,
        highWaterMark: 1,
        transform (chunk: SpeechFlowChunk, encoding, callback) {
            this.push(chunk.payload)
            callback()
        },
        final (callback) {
            this.push(null)
            callback()
        }
    })
}

/*  create a Duplex/Transform stream which has
    object-mode on Readable side and buffer/string-mode on Writable side  */
export function createTransformStreamForReadableSide (type: "text" | "audio", getTimeZero: () => DateTime) {
    return new Stream.Transform({
        readableObjectMode: true,
        writableObjectMode: true,
        decodeStrings: false,
        highWaterMark: (type === "audio" ? 19200 : 65536),
        transform (chunk: Buffer | string, encoding, callback) {
            if (chunk === null) {
                this.push(null)
                callback()
                return
            }
            const timeZero = getTimeZero()
            const start = DateTime.now().diff(timeZero)
            let end = start
            if (type === "audio") {
                const duration = audioBufferDuration(chunk as Buffer)
                end = start.plus(duration * 1000)
            }
            const payload = ensureStreamChunk(type, chunk) as Buffer | string
            const obj = new SpeechFlowChunk(start, end, "final", type, payload)
            this.push(obj)
            callback()
        },
        final (callback) {
            this.push(null)
            callback()
        }
    })
}

/*  ensure a chunk is of a certain type and format  */
export function ensureStreamChunk (type: "audio" | "text", chunk: SpeechFlowChunk | Buffer | string) {
    if (chunk instanceof SpeechFlowChunk) {
        if (chunk.type !== type)
            throw new Error(`invalid payload chunk (expected ${type} type, received ${chunk.type} type)`)
    }
    else {
        if (type === "text" && Buffer.isBuffer(chunk))
            chunk = chunk.toString("utf8")
        else if (type === "audio" && !Buffer.isBuffer(chunk))
            chunk = Buffer.from(chunk)
    }
    return chunk
}

/*  type of a serialized SpeechFlow chunk  */
type SpeechFlowChunkSerialized = {
    timestampStart: number,
    timestampEnd:   number,
    kind:           string,
    type:           string,
    payload:        Uint8Array
}

/*  encode/serialize chunk of data  */
export function streamChunkEncode (chunk: SpeechFlowChunk) {
    let payload: Uint8Array
    if (Buffer.isBuffer(chunk.payload))
        payload = new Uint8Array(chunk.payload)
    else {
        const encoder = new TextEncoder()
        payload = encoder.encode(chunk.payload)
    }
    const data = {
        timestampStart: chunk.timestampStart.toMillis(),
        timestampEnd:   chunk.timestampEnd.toMillis(),
        kind:           chunk.kind,
        type:           chunk.type,
        payload
    } satisfies SpeechFlowChunkSerialized
    const _data = CBOR.encode(data)
    return _data
}

/*  decode/unserialize chunk of data  */
export function streamChunkDecode (_data: Uint8Array) {
    let data: SpeechFlowChunkSerialized
    try {
        data = CBOR.decode<SpeechFlowChunkSerialized>(_data)
    }
    catch (err: any) {
        throw new Error(`CBOR decoding failed: ${err}`)
    }
    let payload: Buffer | string
    if (data.type === "audio")
        payload = Buffer.from(data.payload)
    else
        payload = (new TextDecoder()).decode(data.payload)
    const chunk = new SpeechFlowChunk(
        Duration.fromMillis(data.timestampStart),
        Duration.fromMillis(data.timestampEnd),
        data.kind as "intermediate" | "final",
        data.type as "audio" | "text",
        payload
    )
    return chunk
}

/*  utility class for wrapping a custom stream into a regular Transform stream  */
export class StreamWrapper extends Stream.Transform {
    private foreignStream: any
    private onData  = (chunk: any) => { this.push(chunk) }
    private onError = (err: Error) => { this.emit("error", err) }
    private onEnd   = ()           => { this.push(null) }
    constructor (foreignStream: any, options: Stream.TransformOptions = {}) {
        options.readableObjectMode = true
        options.writableObjectMode = true
        super(options)
        this.foreignStream = foreignStream
        if (typeof this.foreignStream.on === "function") {
            this.foreignStream.on("data",  this.onData)
            this.foreignStream.on("error", this.onError)
            this.foreignStream.on("end",   this.onEnd)
        }
    }
    _transform (chunk: any, encoding: BufferEncoding, callback: Stream.TransformCallback): void {
        if (this.destroyed) {
            callback(new Error("stream already destroyed"))
            return
        }
        try {
            if (typeof this.foreignStream.write === "function") {
                const canContinue = this.foreignStream.write(chunk)
                if (canContinue)
                    callback()
                else
                    this.foreignStream.once("drain", callback)
            }
            else
                throw new Error("foreign stream lacks write method")
        }
        catch (err) {
            callback(err as Error)
        }
    }
    _flush (callback: Stream.TransformCallback): void {
        if (this.destroyed) {
            callback(new Error("stream already destroyed"))
            return
        }
        try {
            if (typeof this.foreignStream.end === "function")
                this.foreignStream.end()
            callback()
        }
        catch (err) {
            callback(err as Error)
        }
    }
    _destroy (error: Error | null, callback: Stream.TransformCallback): void {
        if (typeof this.foreignStream.removeListener === "function") {
            this.foreignStream.removeListener("data",  this.onData)
            this.foreignStream.removeListener("error", this.onError)
            this.foreignStream.removeListener("end",   this.onEnd)
        }
        super._destroy(error, callback)
    }
}
