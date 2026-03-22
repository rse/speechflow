/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
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
export function importObject<T> (name: string, arg: object | string, validator: Type<T, {}>): T {
    const obj: object = typeof arg === "string" ?
        util.run(`${name}: parsing JSON`, () => JSON.parse(arg)) :
        arg
    const result = validator(obj)
    if (result instanceof type.errors)
        throw new Error(`${name}: validation: ${result.summary}`)
    return result as T
}

/*  queue element  */
export type QueueElement = { type: string }

/*  queue pointer  */
export class QueuePointer<T extends QueueElement> extends EventEmitter {
    /*  internal state  */
    private index = 0
    private silence = false

    /*  construction  */
    constructor (
        private name: string,
        private queue: Queue<T>
    ) {
        super()
        this.setMaxListeners(100)
    }

    /*  control silence operation  */
    silent (silence: boolean) {
        this.silence = silence
    }

    /*  notify about operation  */
    notify (event: string, info: any) {
        if (!this.silence)
            this.emit(event, info)
    }

    /*  positioning operations  */
    maxPosition () {
        return this.queue.elements.length
    }
    position (index?: number): number {
        if (index !== undefined) {
            this.index = Math.max(0, Math.min(index, this.queue.elements.length))
            this.notify("position", { start: this.index })
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
            this.notify("position", { start: this.index })
    }
    walkForwardUntil (type: T["type"]) {
        while (this.index < this.queue.elements.length
            && this.queue.elements[this.index].type !== type)
            this.index++
        this.notify("position", { start: this.index })
    }
    walkBackwardUntil (type: T["type"]) {
        while (this.index < this.queue.elements.length
            && this.queue.elements[this.index].type !== type) {
            if (this.index === 0)
                break
            this.index--
        }
        this.notify("position", { start: this.index })
    }

    /*  search operations  */
    searchForward (type: T["type"]) {
        let position = this.index
        while (position < this.queue.elements.length
            && this.queue.elements[position].type !== type)
            position++
        this.notify("search", { start: this.index, end: position })
        return position
    }
    searchBackward (type: T["type"]) {
        let position = this.index
        while (position < this.queue.elements.length
            && this.queue.elements[position].type !== type) {
            if (position === 0)
                break
            position--
        }
        this.notify("search", { start: position, end: this.index })
        return position
    }

    /*  reading operations  */
    peek (position?: number): T | undefined {
        if (position === undefined)
            position = this.index
        position = Math.max(0, Math.min(position, this.queue.elements.length))
        const element = this.queue.elements[position]
        this.queue.notify("read", { start: position, end: position })
        return element
    }
    read (): T | undefined {
        const element = this.queue.elements[this.index]
        if (this.index < this.queue.elements.length)
            this.index++
        this.queue.notify("read", { start: this.index - 1, end: this.index - 1 })
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
        this.queue.notify("read", { start, end: this.index })
        return slice
    }

    /*  writing operations  */
    touch (position?: number) {
        if (position === undefined)
            position = this.index
        if (position >= this.queue.elements.length)
            throw new Error(`cannot touch after last element ${position} ${this.queue.elements.length}`)
        this.queue.notify("write", { start: position, end: position, op: "touch" })
    }
    append (element: T) {
        this.queue.elements.push(element)
        this.index = this.queue.elements.length
        this.queue.notify("write", { start: this.index - 1, end: this.index - 1, op: "append" })
    }
    insert (element: T) {
        this.queue.elements.splice(this.index, 0, element)
        this.queue.notify("write", { start: this.index, end: this.index, op: "insert" })
    }
    delete () {
        if (this.index >= this.queue.elements.length)
            throw new Error("cannot delete after last element")
        this.queue.elements.splice(this.index, 1)
        this.queue.notify("write", { start: this.index, end: this.index, op: "delete" })
    }
}

/*  queue  */
export class Queue<T extends QueueElement> extends EventEmitter {
    public elements: T[] = []
    private pointers = new Map<string, QueuePointer<T>>()
    private silence = false
    constructor () {
        super()
        this.setMaxListeners(100)
    }
    silent (silence: boolean) {
        this.silence = silence
    }
    notify (event: string, info: any) {
        if (!this.silence)
            this.emit(event, info)
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
        for (const pointer of this.pointers.values()) {
            if (min > pointer.position())
                min = pointer.position()
        }

        /*  trim the maximum amount of first elements  */
        if (min > 0) {
            this.elements.splice(0, min)

            /*  shift all pointers  */
            for (const pointer of this.pointers.values())
                pointer.position(pointer.position() - min)

            /*  notify (start/end refer to pre-splice indices)  */
            this.notify("write", { start: 0, end: min, op: "trim" })
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
    private queue = new Array<T>()
    private resolvers: { resolve: (v: T) => void, reject: (err: Error) => void }[] = []
    public destroyed = false
    write (v: T) {
        if (this.destroyed)
            return
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
    drain () {
        const items = this.queue
        this.queue = new Array<T>()
        return items
    }
    destroy () {
        this.destroyed = true
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
    async awaitAll (timeout = 0) {
        const deadline = timeout > 0 ? Date.now() + timeout : 0
        while (this.promises.size > 0) {
            await Promise.all(this.promises)
            if (deadline > 0 && Date.now() >= deadline)
                break
        }
    }
}
