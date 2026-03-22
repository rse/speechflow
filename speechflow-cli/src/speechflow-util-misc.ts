/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  sleep: wait a duration of time and then resolve  */
export function sleep (durationMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            resolve()
        }, durationMs)
        timer.unref()
        if (signal !== undefined)
            signal.addEventListener("abort", () => { clearTimeout(timer) }, { once: true })
    })
}

/*  timeout: wait a duration of time and then reject  */
export function timeout (durationMs: number, info = "timeout", signal?: AbortSignal) {
    return new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(info))
        }, durationMs)
        timer.unref()
        if (signal !== undefined)
            signal.addEventListener("abort", () => { clearTimeout(timer) }, { once: true })
    })
}
