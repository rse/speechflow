/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  external dependencies  */
import Stream                 from "node:stream"
import { EventEmitter }       from "node:events"
import { DateTime, Duration } from "luxon"
import CBOR                   from "cbor2"

/*  internal dependencies  */
import { SpeechFlowChunk } from "./speechflow-node"

/*  calculate duration of an audio buffer  */
export function audioBufferDuration (
    buffer: Buffer,
    sampleRate   = 48000,
    bitDepth     = 16,
    channels     = 1,
    littleEndian = true
) {
    if (!Buffer.isBuffer(buffer))
        throw new Error("invalid input (Buffer expected)")
    if (littleEndian !== true)
        throw new Error("only Little Endian supported")

    const bytesPerSample = bitDepth / 8
    const totalSamples = buffer.length / (bytesPerSample * channels)
    return totalSamples / sampleRate
}

/*  create a Duplex/Transform stream which has
    object-mode on Writable side and buffer/string-mode on Readable side  */
export function createTransformStreamForWritableSide () {
    return new Stream.Transform({
        readableObjectMode: true,
        writableObjectMode: true,
        decodeStrings: false,
        transform (chunk: SpeechFlowChunk, encoding, callback) {
            this.push(chunk.payload)
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
        transform (chunk: Buffer | string, encoding, callback) {
            const timeZero = getTimeZero()
            const start = DateTime.now().diff(timeZero)
            let end = start
            if (type === "audio") {
                const duration = audioBufferDuration(chunk as Buffer)
                end = start.plus(duration * 1000)
            }
            const obj = new SpeechFlowChunk(start, end, "final", type, chunk)
            this.push(obj)
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

/*  helper class for single item queue  */
export class SingleQueue<T> extends EventEmitter {
    private queue = new Array<T>()
    write (item: T) {
        this.queue.unshift(item)
        this.emit("dequeue")
    }
    read () {
        return new Promise<T>((resolve, reject) => {
            const consume = () => {
                if (this.queue.length > 0)
                    return this.queue.pop()!
                else
                    return null
            }
            let item = consume()
            if (item !== null)
                resolve(item)
            else {
                const tryToConsume = () => {
                    item = consume()
                    if (item !== null)
                        resolve(item)
                    else
                        this.once("dequeue", tryToConsume)
                }
                this.once("dequeue", tryToConsume)
            }
        })
    }
}

/*  helper class for double-item queue  */
export class DoubleQueue<T0, T1> extends EventEmitter {
    private queue0 = new Array<T0>()
    private queue1 = new Array<T1>()
    private notify () {
        if (this.queue0.length > 0 && this.queue1.length > 0)
            this.emit("dequeue")
    }
    write0 (item: T0) {
        this.queue0.unshift(item)
        this.notify()
    }
    write1 (item: T1) {
        this.queue1.unshift(item)
        this.notify()
    }
    read () {
        return new Promise<[ T0, T1 ]>((resolve, reject) => {
            const consume = (): [ T0, T1 ] | null => {
                if (this.queue0.length > 0 && this.queue1.length > 0) {
                    const item0 = this.queue0.pop() as T0
                    const item1 = this.queue1.pop() as T1
                    return [ item0, item1 ]
                }
                else
                    return null
            }
            let items = consume()
            if (items !== null)
                resolve(items)
            else {
                const tryToConsume = () => {
                    items = consume()
                    if (items !== null)
                        resolve(items)
                    else
                        this.once("dequeue", tryToConsume)
                }
                this.once("dequeue", tryToConsume)
            }
        })
    }
}
