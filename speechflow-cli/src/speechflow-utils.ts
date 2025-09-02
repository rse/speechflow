/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                 from "node:stream"
import { EventEmitter }       from "node:events"
import { type, type Type }    from "arktype"

/*  external dependencies  */
import { DateTime, Duration } from "luxon"
import * as CBOR              from "cbor2"
import * as IntervalTree      from "node-interval-tree"

/*  internal dependencies  */
import { SpeechFlowChunk }    from "./speechflow-node"

/*  helper function for retrieving an Error object  */
export function ensureError (error: unknown, prefix?: string): Error {
    if (error instanceof Error && prefix === undefined)
        return error
    let msg = error instanceof Error ?
        error.message : String(error)
    if (prefix)
        msg = `${prefix}: ${msg}`
    return new Error(msg, { cause: error })
}

/*  helper function for retrieving a Promise object  */
export function ensurePromise<T> (arg: T | Promise<T>): Promise<T> {
    if (!(arg instanceof Promise))
        arg = Promise.resolve(arg)
    return arg
}

/*  helper function for running the finally code of "run"  */
function runFinally (onfinally?: () => void) {
    if (!onfinally)
        return
    try { onfinally() }
    catch (_arg: unknown) { /*  ignored  */ }
}

/*  helper type for ensuring T contains no Promise  */
type runNoPromise<T> =
    [ T ] extends [ Promise<any> ] ? never : T

/*  run a synchronous or asynchronous action  */
export function run<T, X extends runNoPromise<T> | never> (
    action:      () => X,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): X
export function run<T, X extends runNoPromise<T> | never> (
    description: string,
    action:      () => X,
    oncatch?:    (error: Error) => X | never,
    onfinally?:  () => void
): X
export function run<T, X extends (T | Promise<T>)> (
    action:      () => X,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): Promise<T>
export function run<T, X extends (T | Promise<T>)> (
    description: string,
    action:      () => X,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): Promise<T>
export function run<T> (
    ...args: any[]
): T | Promise<T> | never {
    /*  support overloaded signatures  */
    let description: string | undefined
    let action:      () => T | Promise<T> | never
    let oncatch:     (error: Error) => T | Promise<T> | never
    let onfinally:   () => void
    if (typeof args[0] === "string") {
        description = args[0]
        action      = args[1]
        oncatch     = args[2]
        onfinally   = args[3]
    }
    else {
        action      = args[0]
        oncatch     = args[1]
        onfinally   = args[2]
    }

    /*  perform the action  */
    let result: T | Promise<T>
    try {
        result = action()
    }
    catch (arg: unknown) {
        /*  synchronous case (error branch)  */
        let error = ensureError(arg, description)
        if (oncatch) {
            try {
                result = oncatch(error)
            }
            catch (arg: unknown) {
                error = ensureError(arg, description)
                runFinally(onfinally)
                throw error
            }
            runFinally(onfinally)
            return result
        }
        runFinally(onfinally)
        throw error
    }
    if (result instanceof Promise) {
        /*  asynchronous case (result or error branch)  */
        return result.catch((arg: unknown) => {
            /*  asynchronous case (error branch)  */
            let error = ensureError(arg, description)
            if (oncatch) {
                try {
                    return ensurePromise(oncatch(error))
                }
                catch (arg: unknown) {
                    error = ensureError(arg, description)
                    return Promise.reject(error)
                }
            }
            return Promise.reject(error)
        }).finally(() => {
            /*  asynchronous case (result and error branch)  */
            runFinally(onfinally)
        })
    }
    else {
        /*  synchronous case (result branch)  */
        runFinally(onfinally)
        return result
    }
}

/*  import an object with parsing and strict error handling  */
export function importObject<T>(name: string, arg: object | string, validator: Type<T, {}>): T {
    const obj: object = typeof arg === "string" ?
        run(`${name}: parsing JSON`, () => JSON.parse(arg)) :
        arg
    const result = validator(obj)
    if (result instanceof type.errors)
        throw new Error(`${name}: validation: ${result.summary}`)
    return result as T
}

/*  calculate duration of an audio buffer  */
export function audioBufferDuration (
    buffer: Buffer,
    sampleRate   = 48000,
    bitDepth     = 16,
    channels     = 1,
    littleEndian = true
) {
    /*  sanity check parameters  */
    if (!Buffer.isBuffer(buffer))
        throw new Error("invalid input (Buffer expected)")
    if (littleEndian !== true)
        throw new Error("only Little Endian supported")
    if (sampleRate <= 0)
        throw new Error("sample rate must be positive")
    if (bitDepth <= 0 || bitDepth % 8 !== 0)
        throw new Error("bit depth must be positive and multiple of 8")
    if (channels <= 0)
        throw new Error("channels must be positive")

    /*  calculate duration  */
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
    /*  sanity check parameters  */
    if (arr.length === 0)
        return 0
    if (sampleRate <= 0)
        throw new Error("sample rate must be positive")
    if (channels <= 0)
        throw new Error("channels must be positive")

    /*  calculate duration  */
    const totalSamples = arr.length / channels
    return totalSamples / sampleRate
}

/*  helper function: convert Buffer in PCM/I16 to Float32Array in PCM/F32 format  */
export function convertBufToF32 (buf: Buffer, littleEndian = true) {
    if (buf.length % 2 !== 0)
        throw new Error("buffer length must be even for 16-bit samples")
    const dataView = new DataView(buf.buffer)
    const arr = new Float32Array(buf.length / 2)
    for (let i = 0; i < arr.length; i++)
        arr[i] = dataView.getInt16(i * 2, littleEndian) / 32768
    return arr
}

/*  helper function: convert Float32Array in PCM/F32 to Buffer in PCM/I16 format  */
export function convertF32ToBuf (arr: Float32Array) {
    if (arr.length === 0)
        return Buffer.alloc(0)
    const int16Array = new Int16Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
        let sample = arr[i]
        if (Number.isNaN(sample))
            sample = 0
        int16Array[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)))
    }
    return Buffer.from(int16Array.buffer)
}

/*  helper function: convert Buffer in PCM/I16 to Int16Array  */
export function convertBufToI16 (buf: Buffer, littleEndian = true) {
    if (buf.length % 2 !== 0)
        throw new Error("buffer length must be even for 16-bit samples")
    const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const arr = new Int16Array(buf.length / 2)
    for (let i = 0; i < buf.length / 2; i++)
        arr[i] = dataView.getInt16(i * 2, littleEndian)
    return arr
}

/*  helper function: convert In16Array in PCM/I16 to Buffer  */
export function convertI16ToBuf (arr: Int16Array, littleEndian = true) {
    if (arr.length === 0)
        return Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(arr.length * 2)
    for (let i = 0; i < arr.length; i++) {
        if (littleEndian)
            buf.writeInt16LE(arr[i], i * 2)
        else
            buf.writeInt16BE(arr[i], i * 2)
    }
    return buf
}

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

/*  helper class for single item queue  */
export class SingleQueue<T> extends EventEmitter {
    private queue = new Array<T>()
    write (item: T) {
        this.queue.unshift(item)
        this.emit("dequeue")
    }
    read () {
        return new Promise<T>((resolve, reject) => {
            const consume = () =>
                this.queue.length > 0 ? this.queue.pop()! : null
            const tryToConsume = () => {
                const item = consume()
                if (item !== null)
                    resolve(item)
                else
                    this.once("dequeue", tryToConsume)
            }
            tryToConsume()
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
                return null
            }
            const tryToConsume = () => {
                const items = consume()
                if (items !== null)
                    resolve(items)
                else
                    this.once("dequeue", tryToConsume)
            }
            tryToConsume()
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
        this.setMaxListeners(100)
    }

    /*  positioning operations  */
    maxPosition () {
        return this.queue.elements.length
    }
    position (index?: number): number {
        if (index !== undefined) {
            this.index = Math.max(0, Math.min(index, this.queue.elements.length))
            this.emit("position", this.index)
        }
        return this.index
    }
    walk (num: number) {
        const indexOld = this.index
        if (num > 0)
            this.index = Math.min(this.index + num, this.queue.elements.length)
        else if (num < 0)
            this.index = Math.max(this.index + num, 0)
        if (this.index !== indexOld)
            this.emit("position", { start: this.index })
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
        position = Math.max(0, Math.min(position, this.queue.elements.length))
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
            size = Math.max(0, Math.min(size, this.queue.elements.length - this.index))
            slice = this.queue.elements.slice(this.index, this.index + size)
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
        this.queue.elements.splice(this.index, 0, element)
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
    constructor () {
        super()
        this.setMaxListeners(100)
    }
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
        if (min > 0) {
            this.elements.splice(0, min)

            /*  shift all pointers  */
            for (const pointer of this.pointers.values())
                pointer.position(pointer.position() - min)
        }
    }
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

/*  meta store  */
interface TimeStoreInterval<T> extends IntervalTree.Interval {
    item: T
}
export class TimeStore<T> extends EventEmitter {
    private tree = new IntervalTree.IntervalTree<TimeStoreInterval<T>>()
    store (start: Duration, end: Duration, item: T): void {
        this.tree.insert({ low: start.toMillis(), high: end.toMillis(), item })
    }
    fetch (start: Duration, end: Duration): T[] {
        const intervals = this.tree.search(start.toMillis(), end.toMillis())
        return intervals.map((interval) => interval.item)
    }
    prune (_before: Duration): void {
        const before = _before.toMillis()
        const intervals = this.tree.search(0, before - 1)
        for (const interval of intervals)
            if (interval.low < before && interval.high < before)
                this.tree.remove(interval)
    }
    clear (): void {
        this.tree = new IntervalTree.IntervalTree<TimeStoreInterval<T>>()
    }
}

/*  asynchronous queue  */
export class AsyncQueue<T> {
    private queue: Array<T | null> = []
    private resolvers: ((v: T | null) => void)[] = []
    write (v: T | null) {
        const resolve = this.resolvers.shift()
        if (resolve)
            resolve(v)
        else
            this.queue.push(v)
    }
    async read () {
        if (this.queue.length > 0)
            return this.queue.shift()!
        else
            return new Promise<T | null>((resolve) => this.resolvers.push(resolve))
    }
    destroy () {
        for (const resolve of this.resolvers)
            resolve(null)
        this.resolvers = []
        this.queue = []
    }
}

/*  process Int16Array in fixed-size segments  */
export async function processInt16ArrayInSegments (
    data: Int16Array<ArrayBuffer>,
    segmentSize: number,
    processor: (segment: Int16Array<ArrayBuffer>) => Promise<Int16Array<ArrayBuffer>>
): Promise<Int16Array<ArrayBuffer>> {
    /*  process full segments  */
    let i = 0
    while ((i + segmentSize) <= data.length) {
        const segment = data.slice(i, i + segmentSize)
        const result = await processor(segment)
        data.set(result, i)
        i += segmentSize
    }

    /*  process final partial segment if it exists  */
    if (i < data.length) {
        const len = data.length - i
        const segment = new Int16Array(segmentSize)
        segment.set(data.slice(i), 0)
        segment.fill(0, len, segmentSize)
        const result = await processor(segment)
        data.set(result.slice(0, len), i)
    }
    return data
}

/*  cached regular expression class  */
export class CachedRegExp {
    private cache = new Map<string, RegExp>()
    compile (pattern: string): RegExp | null {
        if (this.cache.has(pattern))
            return this.cache.get(pattern)!
        try {
            const regex = new RegExp(pattern)
            this.cache.set(pattern, regex)
            return regex
        }
        catch (_error) {
            return null
        }
    }
    clear (): void {
        this.cache.clear()
    }
    size (): number {
        return this.cache.size
    }
}

/*  helper functions for linear/decibel conversions  */
export function lin2dB (x: number): number {
    return 20 * Math.log10(Math.max(x, 1e-12))
}
export function dB2lin (db: number): number {
    return Math.pow(10, db / 20)
}
