/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  sleep: wait a duration of time and then resolve  */
export function sleep (durationMs: number) {
    return new Promise<void>((resolve) => {
        setTimeout(() => {
            resolve()
        }, durationMs)
    })
}

/*  timeout: wait a duration of time and then reject  */
export function timeout (durationMs: number) {
    return new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
            reject(new Error("timeout"))
        }, durationMs)
    })
}
