/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path                              from "node:path"
import WorkerThreads                     from "node:worker_threads"

/*  external dependencies  */
import * as Transformers                 from "@huggingface/transformers"

/*  internal dependencies  */
import { WorkerRequest, WorkerResponse } from "./speechflow-node-whisper-common"

/*  utility function for sending a log message  */
const log = (message: string) =>
    WorkerThreads.parentPort!.postMessage({ type: "log", message })

/*  internal state  */
let transcriber: Transformers.AutomaticSpeechRecognitionPipeline | null = null

/*  OpenAI Whisper models (ONNX variants)  */
const models = {
    "v1-tiny":        { model: "onnx-community/whisper-tiny-ONNX" },
    "v1-base":        { model: "onnx-community/whisper-base" },
    "v1-small":       { model: "onnx-community/whisper-small" },
    "v1-medium":      { model: "onnx-community/whisper-medium-ONNX" },
    "v2-large":       { model: "reach-vb/whisper-large-v2-onnx" },
    "v3-large":       { model: "onnx-community/whisper-large-v3-ONNX" },
    "v3-large-turbo": { model: "onnx-community/whisper-large-v3-turbo" }
}
/*  thread communication hook  */
WorkerThreads.parentPort?.on("message", async (request: WorkerRequest) => {
    let response: WorkerResponse | null = null
    if (request.type === "open") {
        /*  initialize Whisper  */
        const model = models[request.model as keyof typeof models]?.model
        if (!model)
            response = { type: "error", message: `unknown Whisper model "${request.model}"` }
        else {
            log(`loading Whisper model "${request.model}": BEGIN`)
            transcriber = await Transformers.pipeline(
                "automatic-speech-recognition", model, {
                    cache_dir: path.join(request.cacheDir, "whisper"),
                    dtype:     "q4",
                    device:    "gpu"
                }
            )
            if (transcriber === null) {
                log(`loading Whisper model "${request.model}": FAILED`)
                response = { type: "error", message: "failed to open Whisper" }
            }
            else {
                log(`loading Whisper model "${request.model}": SUCCESS`)
                response = { type: "ok" }
            }
        }
    }
    else if (request.type === "task-request") {
        /*  perform a speech-to-text transcription with Whisper  */
        /*
        const streamer = new Transformers.TextStreamer(transcriber!.tokenizer, {
            skip_prompt: true,
            callback_function: (text) => {
                console.log("TEXT", text)
            }
        })
        */
        log(`${request.task.type} transcription task ${request.task.id}": START`)
        const result = await transcriber!(request.task.audio, {
            chunk_length_s:       3,
            stride_length_s:      1,
            language:             request.task.language,
            task:                 "transcribe",
            force_full_sequences: false,
            use_cache:            true,
            return_timestamps:    true,
            // streamer
        })
        log(`${request.task.type} transcription task ${request.task.id}": END`)
        console.log("RESULT", JSON.stringify(result))
        const text = Array.isArray(result) ? result[0].text : result.text
        const taskResponse = {
            type:     request.task.type,
            id:       request.task.id,
            language: request.task.language,
            text:     text ?? ""
        }
        response = { type: "task-response", task: taskResponse }
    }
    else if (request.type === "close") {
        /*  shutdown Whisper  */
        if (transcriber !== null) {
            log("unloading Whisper model: BEGIN")
            await transcriber.dispose()
            transcriber = null
            log("unloading Whisper model: END")
        }
    }
    if (response !== null)
        WorkerThreads.parentPort!.postMessage(response)
})
