/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  internal dependencies  */
import { parentPort } from "node:worker_threads"

/*  external dependencies  */
import { type DenoiseState, Rnnoise } from "@shiguredo/rnnoise-wasm"

/*  WASM state  */
let rnnoise: Rnnoise
let denoiseState: DenoiseState

/*  global initialization  */
;(async () => {
    try {
        rnnoise = await Rnnoise.load()
        denoiseState = rnnoise.createDenoiseState()
        parentPort!.postMessage({ type: "ready" })
    }
    catch (err) {
        parentPort!.postMessage({ type: "failed", message: `failed to initialize RNNoise: ${err}` })
        process.exit(1)
    }
})()

/*  receive messages  */
parentPort!.on("message", (msg) => {
    if (msg.type === "process") {
        /*  process a single audio frame  */
        const { id, data } = msg

        /*  convert regular Int16Array [-32768,32768]
            to unusual non-normalized Float32Array [-32768,32768]
            as required by RNNoise  */
        const f32a = new Float32Array(data.length)
        for (let i = 0; i < data.length; i++)
            f32a[i] = data[i]

        /*  process frame with RNNoise WASM  */
        denoiseState.processFrame(f32a)

        /*  convert back Float32Array to Int16Array  */
        const i16 = new Int16Array(data.length)
        for (let i = 0; i < data.length; i++)
            i16[i] = Math.round(f32a[i])

        parentPort!.postMessage({ type: "process-done", id, data: i16 }, [ i16.buffer ])
    }
    else if (msg.type === "close") {
        /*  shutdown this process  */
        try {
            denoiseState.destroy()
        }
        finally {
            process.exit(0)
        }
    }
})