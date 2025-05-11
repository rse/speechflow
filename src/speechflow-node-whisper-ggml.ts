/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import WorkerThreads                     from "node:worker_threads"

/*  external dependencies  */
import { Whisper, manager }              from "smart-whisper"

/*  internal dependencies  */
import { WorkerRequest, WorkerResponse } from "./speechflow-node-whisper-common"

/*  utility function for sending a log message  */
const log = (message: string) =>
    WorkerThreads.parentPort!.postMessage({ type: "log", message })

/*  internal state  */
let whisper: Whisper | null = null

/*  OpenAI Whisper models (GGML variants for Whisper.cpp)  */
const models = {
    "v1-tiny":        { model: "tiny" },
    "v1-base":        { model: "base" },
    "v1-small":       { model: "small" },
    "v1-medium":      { model: "medium" },
    "v2-large":       { model: "large-v2" },
    "v3-large":       { model: "large-v3" },
    "v3-large-turbo": { model: "large-v3-turbo" }
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
            const name = await manager.download(model)
            const resolved = manager.resolve(name)
            whisper = new Whisper(resolved, {
                gpu: true,
                offload: 120 * 60
            })
            if (whisper === null) {
                log(`loading Whisper model "${request.model}": FAILED`)
                response = { type: "error", message: "failed to open Whisper" }
            }
            else {
                await whisper.load()
                log(`loading Whisper model "${request.model}": SUCCESS`)
                response = { type: "ok" }
            }
        }
    }
    else if (request.type === "task-request") {
        log(`${request.task.type} transcription task ${request.task.id}": START`)
        const task = await whisper!.transcribe(request.task.audio, {
            language:                   request.task.language,
            n_threads:                  16,
            no_timestamps:              false,
            speed_up:                   true,
            suppress_non_speech_tokens: true,
            suppress_blank:             true,
            debug_mode:                 false,
            print_special:              false,
            print_progress:             false,
            print_realtime:             false,
            print_timestamps:           false
        })
        task.on("transcribed", (result) => {
            console.log("TRANSCRIBED", JSON.stringify(result))
        })
        const result = await task.result
        log(`${request.task.type} transcription task ${request.task.id}": END`)
        console.log("RESULT", result)
        const text = result[0].text
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
        if (whisper !== null) {
            log("unloading Whisper model: BEGIN")
            await whisper.free()
            whisper = null
            log("unloading Whisper model: END")
        }
    }
    if (response !== null)
        WorkerThreads.parentPort!.postMessage(response)
})
