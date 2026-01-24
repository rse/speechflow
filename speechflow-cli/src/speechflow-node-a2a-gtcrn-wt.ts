/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { parentPort, workerData }     from "node:worker_threads"

/*  external dependencies  */
import SherpaOnnx                     from "sherpa-onnx"
import type {
    SherpaOnnxDenoiserConfig,
    SherpaOnnxOfflineSpeechDenoiser
}                                     from "sherpa-onnx"

/*  receive model path from parent thread  */
const modelPath: string = workerData.modelPath

/*  GTCRN state  */
let denoiser: SherpaOnnxOfflineSpeechDenoiser

/*  helper: log message to parent  */
const log = (level: string, message: string) => {
    parentPort!.postMessage({ type: "log", level, message })
}

/*  initialize globals  */
;(async () => {
    try {
        /*  create denoiser  */
        const config: SherpaOnnxDenoiserConfig = {
            model: {
                gtcrn: {
                    model: modelPath
                }
            },
            numThreads: 1
        }
        denoiser = SherpaOnnx.createOfflineSpeechDenoiser(config)
        log("info", "GTCRN denoiser initialized")
        parentPort!.postMessage({ type: "ready" })
    }
    catch (err) {
        parentPort!.postMessage({ type: "failed", message: `failed to initialize GTCRN: ${err}` })
        process.exit(1)
    }
})()

/*  receive messages  */
parentPort!.on("message", (msg) => {
    if (msg.type === "process") {
        const { id, samples } = msg

        /*  process with GTCRN denoiser
            NOTICE: GTCRN can also resample out input, but will always
            produces 16KHz output, so we already fixate 16KHz input here!  */
        const result = denoiser.run(samples, 16000)

        /*  copy to transferable ArrayBuffer and send back to parent  */
        const samplesDenoised = new Float32Array(result.samples)
        parentPort!.postMessage({ type: "process-done", id, data: samplesDenoised }, [ samplesDenoised.buffer ])
    }
    else if (msg.type === "close") {
        /*  shutdown this process  */
        process.exit(0)
    }
})
