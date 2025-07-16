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

/*  calculate duration of an audio array  */
export function audioArrayDuration (
    arr: Float32Array,
    sampleRate   = 48000,
    channels     = 1
) {
    const totalSamples = arr.length / channels
    return totalSamples / sampleRate
}

/*  helper function: convert Buffer in PCM/I16 to Float32Array in PCM/F32 format  */
export function convertBufToF32 (buf: Buffer, littleEndian = true) {
    const dataView = new DataView(buf.buffer)
    const arr = new Float32Array(buf.length / 2)
    for (let i = 0; i < arr.length; i++)
        arr[i] = dataView.getInt16(i * 2, littleEndian) / 32768
    return arr
}

/*  helper function: convert Float32Array in PCM/F32 to Buffer in PCM/I16 format  */
export function convertF32ToBuf (arr: Float32Array) {
    const int16Array = new Int16Array(arr.length)
    for (let i = 0; i < arr.length; i++)
        int16Array[i] = Math.max(-32768, Math.min(32767, Math.round(arr[i] * 32768)))
    return Buffer.from(int16Array.buffer)
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

/*  queue element */
export type QueueElement = { type: string }

/*  queue pointer  */
export class QueuePointer<T extends QueueElement> extends EventEmitter {
    /*  internal state  */
    private index = 0

    /*  construction  */
    constructor (
        private name: string,
        private queue: Queue<T>
    ) {
        super()
    }

    /*  positioning operations  */
    maxPosition () {
        return this.queue.elements.length
    }
    position (index?: number): number {
        if (index !== undefined) {
            this.index = index
            if (this.index < 0)
                this.index = 0
            else if (this.index >= this.queue.elements.length)
                this.index = this.queue.elements.length
            this.emit("position", this.index)
        }
        return this.index
    }
    walk (num: number) {
        if (num > 0) {
            for (let i = 0; i < num && this.index < this.queue.elements.length; i++)
                this.index++
            this.emit("position", { start: this.index })
        }
        else if (num < 0) {
            for (let i = 0; i < Math.abs(num) && this.index > 0; i++)
                this.index--
            this.emit("position", { start: this.index })
        }
    }
    walkForwardUntil (type: T["type"]) {
        while (this.index < this.queue.elements.length
            && this.queue.elements[this.index].type !== type)
            this.index++
        this.emit("position", { start: this.index })
    }
    walkBackwardUntil (type: T["type"]) {
        while (this.index > 0
            && this.queue.elements[this.index].type !== type)
            this.index--
        this.emit("position", { start: this.index })
    }

    /*  search operations  */
    searchForward (type: T["type"]) {
        let position = this.index
        while (position < this.queue.elements.length
            && this.queue.elements[position].type !== type)
            position++
        this.emit("search", { start: this.index, end: position })
        return position
    }
    searchBackward (type: T["type"]) {
        let position = this.index
        while (position > 0
            && this.queue.elements[position].type !== type)
            position--
        this.emit("search", { start: position, end: this.index })
        return position
    }

    /*  reading operations  */
    peek (position?: number) {
        if (position === undefined)
            position = this.index
        else {
            if (position < 0)
                position = 0
            else if (position > this.queue.elements.length)
                position = this.queue.elements.length
        }
        const element = this.queue.elements[position]
        this.queue.emit("read", { start: position, end: position })
        return element
    }
    read () {
        const element = this.queue.elements[this.index]
        if (this.index < this.queue.elements.length)
            this.index++
        this.queue.emit("read", { start: this.index - 1, end: this.index - 1 })
        return element
    }
    slice (size?: number) {
        let slice: T[]
        const start = this.index
        if (size !== undefined) {
            if (size < 0)
                size = 0
            else if (size > this.queue.elements.length - this.index)
                size = this.queue.elements.length - this.index
            slice = this.queue.elements.slice(this.index, size)
            this.index += size
        }
        else {
            slice = this.queue.elements.slice(this.index)
            this.index = this.queue.elements.length
        }
        this.queue.emit("read", { start, end: this.index })
        return slice
    }

    /*  writing operations  */
    touch () {
        if (this.index >= this.queue.elements.length)
            throw new Error("cannot touch after last element")
        this.queue.emit("write", { start: this.index, end: this.index + 1 })
    }
    append (element: T) {
        this.queue.elements.push(element)
        this.index = this.queue.elements.length
        this.queue.emit("write", { start: this.index - 1, end: this.index - 1 })
    }
    insert (element: T) {
        this.queue.elements.splice(this.index++, 0, element)
        this.queue.emit("write", { start: this.index - 1, end: this.index })
    }
    delete () {
        if (this.index >= this.queue.elements.length)
            throw new Error("cannot delete after last element")
        this.queue.elements.splice(this.index, 1)
        this.queue.emit("write", { start: this.index, end: this.index })
    }
}

/*  queue  */
export class Queue<T extends QueueElement> extends EventEmitter {
    public elements: T[] = []
    private pointers = new Map<string, QueuePointer<T>>()
    pointerUse (name: string): QueuePointer<T> {
        if (!this.pointers.has(name))
            this.pointers.set(name, new QueuePointer<T>(name, this))
        return this.pointers.get(name)!
    }
    pointerDelete (name: string): void {
        if (!this.pointers.has(name))
            throw new Error("pointer not exists")
        this.pointers.delete(name)
    }
    trim (): void {
        /*  determine minimum pointer position  */
        let min = this.elements.length
        for (const pointer of this.pointers.values())
            if (min > pointer.position())
                min = pointer.position()

        /*  trim the maximum amount of first elements  */
        this.elements.splice(0, min)

        /*  shift all pointers  */
        for (const pointer of this.pointers.values())
            pointer.position(pointer.position() - min)
    }
}

