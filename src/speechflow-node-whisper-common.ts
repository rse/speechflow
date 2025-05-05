/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

export type TranscriptionTaskRequest = {
    type:     "intermediate" | "final"
    id:       number
    language: string
    audio:    Float32Array
}

export type TranscriptionTaskResponse = {
    type:     "intermediate" | "final"
    id:       number
    language: string
    text:     string
}

export type WorkerRequest =
    { type: "open", cacheDir: string, model: string } |
    { type: "task-request", task: TranscriptionTaskRequest } |
    { type: "close" }

export type WorkerResponse =
    { type: "log", message: string } |
    { type: "error", message: string } |
    { type: "ok" } |
    { type: "task-response", task: TranscriptionTaskResponse }
