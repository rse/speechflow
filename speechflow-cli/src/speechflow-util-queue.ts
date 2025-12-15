/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { EventEmitter }       from "node:events"

/*  external dependencies  */
import { type, type Type }    from "arktype"
import { Duration }           from "luxon"
import * as IntervalTree      from "node-interval-tree"

/*  internal dependencies  */
import * as util              from "./speechflow-util"

/*  import an object with parsing and strict error handling  */
export function importObject<T>(name: string, arg: object | string, validator: Type<T, {}>): T {
    const obj: object = typeof arg === "string" ?
        util.run(`${name}: parsing JSON`, () => JSON.parse(arg)) :
        arg
    const result = validator(obj)
    if (result instanceof type.errors)
        throw new Error(`${name}: validation: ${result.summary}`)
    return result as T
}

/*  helper class for single item queue  */
export class SingleQueue<T> extends EventEmitter {
    private queue = new Array<T>()
    write (item: T) {
        this.queue.unshift(item)
        this.emit("dequeue")
    }
    read () {
        return new Promise<T>((resolve) => {
            const tryToConsume = () => {
                const item = this.queue.pop()
                if (item !== undefined)
                    resolve(item)
                else
                    this.once("dequeue", tryToConsume)
            }
            tryToConsume()
        })
    }
    drain () {
        const items = this.queue
        this.queue = new Array<T>()
        return items
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
        return new Promise<[ T0, T1 ]>((resolve) => {
            const consume = (): [ T0, T1 ] | undefined => {
                if (this.queue0.length > 0 && this.queue1.length > 0) {
                    const item0 = this.queue0.pop() as T0
                    const item1 = this.queue1.pop() as T1
                    return [ item0, item1 ]
                }
                return undefined
            }
            const tryToConsume = () => {
                const items = consume()
                if (items !== undefined)
                    resolve(items)
                else
                    this.once("dequeue", tryToConsume)
            }
            tryToConsume()
        })
    }
}

/*  queue element  */
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
            throw new Error("pointer does not exist")
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
    private queue: Array<T> = []
    private resolvers: { resolve: (v: T) => void, reject: (err: Error) => void }[] = []
    write (v: T) {
        const resolver = this.resolvers.shift()
        if (resolver)
            resolver.resolve(v)
        else
            this.queue.push(v)
    }
    async read () {
        if (this.queue.length > 0)
            return this.queue.shift()!
        else
            return new Promise<T>((resolve, reject) => { this.resolvers.push({ resolve, reject }) })
    }
    empty () {
        return this.queue.length === 0
    }
    destroy () {
        for (const resolver of this.resolvers)
            resolver.reject(new Error("AsyncQueue destroyed"))
        this.resolvers = []
        this.queue = []
    }
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

/*  set of promises  */
export class PromiseSet<T> {
    private promises = new Set<Promise<T>>()
    add (promise: Promise<T>) {
        this.promises.add(promise)
        promise.finally(() => {
            this.promises.delete(promise)
        }).catch(() => {})
    }
    async awaitAll () {
        await Promise.all(this.promises)
    }
}
