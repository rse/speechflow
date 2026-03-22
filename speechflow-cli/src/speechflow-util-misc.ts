/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  external dependencies  */
import { DateTime, Duration } from "luxon"

/*  deep-clone a value while being aware of special class instances  */
export const deepClone = (value: any): any => {
    if (value === null || value === undefined || Number.isNaN(value))
        return value
    else if (typeof value !== "object")
        return value
    else if (Buffer.isBuffer(value))
        return Buffer.from(value)
    else if (value instanceof Uint8Array)
        return new Uint8Array(value)
    else if (value instanceof Duration)
        return Duration.fromMillis(value.toMillis())
    else if (value instanceof DateTime)
        return DateTime.fromMillis(value.toMillis())
    else if (Array.isArray(value))
        return value.map((item) => deepClone(item))
    else if (value instanceof Map) {
        const result = new Map()
        for (const [ k, v ] of value)
            result.set(deepClone(k), deepClone(v))
        return result
    }
    else if (value instanceof Set) {
        const result = new Set()
        for (const v of value)
            result.add(deepClone(v))
        return result
    }
    else if (Object.getPrototypeOf(value) === Object.prototype) {
        const result: any = {}
        for (const key of Object.keys(value))
            result[key] = deepClone(value[key])
        return result
    }
    else
        return structuredClone(value)
}

/*  sleep: wait a duration of time and then resolve  */
export function sleep (durationMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
        const ac = new AbortController()
        const timer = setTimeout(() => {
            ac.abort()
            resolve()
        }, durationMs)
        timer.unref()
        if (signal !== undefined)
            signal.addEventListener("abort", () => {
                clearTimeout(timer)
                resolve()
            }, { once: true, signal: ac.signal })
    })
}

/*  timeout: wait a duration of time and then reject  */
export function timeout (durationMs: number, info = "timeout", signal?: AbortSignal) {
    return new Promise<never>((resolve, reject) => {
        const ac = new AbortController()
        const timer = setTimeout(() => {
            ac.abort()
            reject(new Error(info))
        }, durationMs)
        timer.unref()
        if (signal !== undefined)
            signal.addEventListener("abort", () => {
                clearTimeout(timer)
                resolve(undefined as never)
            }, { once: true, signal: ac.signal })
    })
}
