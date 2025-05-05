/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path               from "node:path"
import { EventEmitter }   from "node:events"
import Stream             from "node:stream"
import { Worker }         from "node:worker_threads"

/*  external dependencies  */
import * as Transformers  from "@huggingface/transformers"
import * as wavefile      from "wavefile"
import { RealTimeVAD }    from "@ericedouard/vad-node-realtime"

/*  internal dependencies  */
import SpeechFlowNode     from "./speechflow-node"
import {
    WorkerRequest,
    WorkerResponse,
    TranscriptionTaskRequest,
    TranscriptionTaskResponse
} from "./speechflow-node-whisper-common"

/*  audio stream queue element */
type AudioQueueElement =
    { type: "audio-frame", data: Float32Array } |
    { type: "speech-start" } |
    { type: "speech-end", short: boolean } |
    { type: "transcript-start", transcript: string } |
    { type: "transcript-end" }

/*  audio stream queue pointer  */
class AudioQueuePointer extends EventEmitter {
    /*  internal state  */
    private index = 0

    /*  construction  */
    constructor (
        private name: string,
        private queue: AudioQueue
    ) {
        super()
    }

    /*  positioning operations  */
    maxPosition () {
        return this.queue.elements.length
    }
    position (index?: number): number {
        if (index !== undefined) {
            this.index = index
            if (this.index < 0)
                this.index = 0
            else if (this.index >= this.queue.elements.length)
                this.index = this.queue.elements.length
            this.emit("position", this.index)
        }
        return this.index
    }
    walk (num: number) {
        if (num > 0) {
            for (let i = 0; i < num && this.index < this.queue.elements.length; i++)
                this.index++
            this.emit("position", { start: this.index })
        }
        else if (num < 0) {
            for (let i = 0; i < Math.abs(num) && this.index > 0; i++)
                this.index--
            this.emit("position", { start: this.index })
        }
    }
    walkForwardUntil (type: AudioQueueElement["type"]) {
        while (this.index < this.queue.elements.length
            && this.queue.elements[this.index].type !== type)
            this.index++
        this.emit("position", { start: this.index })
    }
    walkBackwardUntil (type: AudioQueueElement["type"]) {
        while (this.index > 0
            && this.queue.elements[this.index].type !== type)
            this.index--
        this.emit("position", { start: this.index })
    }

    /*  search operations  */
    searchForward (type: AudioQueueElement["type"]) {
        let position = this.index
        while (position < this.queue.elements.length
            && this.queue.elements[position].type !== type)
            position++
        this.emit("search", { start: this.index, end: position })
        return position
    }
    searchBackward (type: AudioQueueElement["type"]) {
        let position = this.index
        while (position > 0
            && this.queue.elements[position].type !== type)
            position--
        this.emit("search", { start: position, end: this.index })
    }

    /*  reading operations  */
    peek (position?: number) {
        if (position === undefined)
            position = this.index
        else {
            if (position < 0)
                position = 0
            else if (position >= this.queue.elements.length)
                position = this.queue.elements.length
        }
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
        let slice: AudioQueueElement[]
        const start = this.index
        if (size !== undefined) {
            slice = this.queue.elements.slice(this.index, size)
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
    append (element: AudioQueueElement) {
        this.queue.elements.push(element)
        this.index = this.queue.elements.length
        this.queue.emit("write", { start: this.index - 1, end: this.index - 1 })
    }
    insert (element: AudioQueueElement) {
        this.queue.elements.splice(this.index++, 0, element)
        this.queue.emit("write", { start: this.index - 1, end: this.index })
    }
    delete () {
        if (this.index >= this.queue.elements.length)
            throw new Error("cannot delete after last element")
        this.queue.elements.splice(this.index, 1)
        this.queue.emit("write", { start: this.index, end: this.index })
    }
}

/*  audio stream queue  */
class AudioQueue extends EventEmitter {
    public elements: AudioQueueElement[] = []
    private pointers = new Map<string, AudioQueuePointer>()
    pointerUse (name: string): AudioQueuePointer {
        if (!this.pointers.has(name))
            this.pointers.set(name, new AudioQueuePointer(name, this))
        return this.pointers.get(name)!
    }
    pointerDelete (name: string): void {
        if (!this.pointers.has(name))
            throw new Error("pointer not exists")
        this.pointers.delete(name)
    }
    trim (): void {
        /*  determine minimum pointer position  */
        let min = this.elements.length
        for (const pointer of this.pointers.values())
            if (min > pointer.position())
                min = pointer.position()

        /*  trim the maximum amount of first elements  */
        this.elements.splice(0, min)

        /*  shift all pointers  */
        for (const pointer of this.pointers.values())
            pointer.position(pointer.position() - min)
    }
}

/*  transcription queue  */
class TranscriptionQueue extends EventEmitter {
    private tasks: TranscriptionTaskRequest[] = []
    private timer: ReturnType<typeof setInterval> | null = null
    private busy = false
    private worker: Worker | null = null
    constructor (
        private cacheDir: string,
        private model:    string,
        private log:      (msg: string) => void
    ) {
        super()
    }
    enqueue (task: TranscriptionTaskRequest) {
        /*  destroy previous tasks of same id  */
        while (this.tasks.length > 0
            && this.tasks[this.tasks.length - 1].id === task.id) {
            this.log(`dropping existing queued request for ${task.type} transcription task #${task.id}`)
            this.tasks.splice(this.tasks.length - 1, 1)
        }

        /*  add task  */
        this.log(`enqueue request for ${task.type} transcription task #${task.id}`)
        this.tasks.push(task)
        this.dequeue()
    }
    dequeue () {
        if (this.tasks.length === 0)
            return
        if (!this.busy && this.worker !== null) {
            this.busy = true
            const task = this.tasks.shift()
            if (task !== undefined) {
                this.log(`dequeue and send request for ${task.type} transcription task #${task.id}`)
                this.worker.postMessage({ type: "task-request", task } satisfies WorkerRequest)
            }
        }
    }
    async start () {
        this.log("start transcription service worker: BEGIN")
        const script = path.resolve(__dirname, "speechflow-node-whisper-worker.js")
        this.worker = new Worker(script, { env: { ...process.env } })
        this.worker.postMessage({
            type:     "open",
            cacheDir: this.cacheDir,
            model:    this.model
        })
        this.worker.on("message", (response: WorkerResponse) => {
            if (response.type === "log")
                this.log(response.message)
        })
        await new Promise<void>((resolve, reject) => {
            let cb: ((response: WorkerResponse) => void) | null = null
            const cleanResolve = () => {
                this.worker!.off("message", cb!)
                resolve()
            }
            const cleanReject = (error: Error) => {
                this.worker!.off("message", cb!)
                reject(error)
            }
            cb = (response: WorkerResponse) => {
                if (response.type === "ok")
                    cleanResolve()
                else if (response.type === "error")
                    cleanReject(new Error(response.message))
            }
            this.worker!.on("message", cb)
        })
        this.worker.on("message", (response: WorkerResponse) => {
            this.busy = false
            if (response.type === "error")
                this.emit("error", response.message)
            else if (response.type === "task-response") {
                console.log(`receive response for task #${response.task.id}`)
                this.emit("task", response.task)
            }
            this.dequeue()
        })
        if (this.timer !== null)
            clearTimeout(this.timer)
        this.timer = setInterval(() => {
            this.dequeue()
        }, 10)
        this.log("start transcription service worker: END")
    }
    async stop () {
        this.log("stop transcription service worker: BEGIN")
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
        if (this.worker !== null) {
            this.worker.postMessage({ type: "close" })
            await this.worker.terminate()
            this.worker = null
        }
        this.busy = false
        this.log("stop transcription service worker: END")
    }
}

/*  SpeechFlow node for Whisper speech-to-text conversion  */
export default class SpeechFlowNodeWhisper extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "whisper"

    /*  OpenAI Whisper https://github.com/openai/whisper/  */
    private models = {
        "v1-tiny": {
            version:  "v1", released: "2022-09", paramsM: 39, vramGB: 1, speed: 10,
            url:      "onnx-community/whisper-tiny-ONNX"
        },
        "v1-base": {
            version:  "v1", released: "2022-09", paramsM: 74, vramGB: 1, speed: 7,
            url:      "onnx-community/whisper-base"
        },
        "v1-small": {
            version:  "v1", released: "2022-09", paramsM: 244, vramGB: 2, speed: 4,
            url:      "onnx-community/whisper-small",
        },
        "v1-medium": {
            version:  "v1", released: "2022-09", paramsM: 769, vramGB: 5, speed: 2,
            url:      "onnx-community/whisper-medium-ONNX"
        },
        "v2-large": {
            version:  "v2", released: "2022-12", paramsM: 1550, vramGB: 10, speed: 1,
            url:      "reach-vb/whisper-large-v2-onnx"
        },
        "v3-large": {
            version:  "v3", released: "2023-11", paramsM: 1550, vramGB: 10, speed: 1,
            url:      "onnx-community/whisper-large-v3-ONNX"
        },
        "v3-large-turbo": {
            version:  "v3", released: "2024-09", paramsM: 798, vramGB: 6, speed: 8,
            url:      "onnx-community/whisper-large-v3-turbo"
        }
    }

    /*  internal state  */
    private transcriber: Transformers.AutomaticSpeechRecognitionPipeline | null = null
    private vad: RealTimeVAD | null = null
    private queue     = new AudioQueue()
    private queueRecv = this.queue.pointerUse("recv")
    private queueVAD  = this.queue.pointerUse("vad")
    private queueSTT  = this.queue.pointerUse("stt")
    private tqueue: TranscriptionQueue | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            language: { type: "string", val: "en",             pos: 0, match: /^(?:en|de)$/ },
            model:    { type: "string", val: "v3-large-turbo", pos: 1 }
        })

        /*  sanity check model  */
        if (this.models[this.params.model as keyof typeof this.models] === undefined)
            throw new Error(`invalid OpenAI Whisper model "${this.params.model}`)

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Whisper node currently supports PCM-S16LE audio only")

        /*  pass-through logging  */
        const log = (level: string, msg: string) => {
            this.log(level, msg)
        }

        /*  create queue for results  */
        // let   queueInput  = Promise.resolve()
        // let   queueInput  = []
        const queueOutput = new EventEmitter()

        const sampleRateTarget   = 16000
        const samplesPerVADFrame = 512 /* required for VAD v5 */
        const minFramesPerSecond = Math.trunc(sampleRateTarget / samplesPerVADFrame) + 1

        /*  initialize the transcription pipeline  */
        const model = this.models[this.params.model as keyof typeof this.models]
        this.log("info", `loading OpenAI Whisper ${this.params.model} ` +
            `(version: ${model.version}, released: ${model.released}, parameters: ${model.paramsM})`)

        /*  transcribe a chunk of audio  */
        this.tqueue = new TranscriptionQueue(
            this.config.cacheDir,
            model.url,
            (msg: string) => { this.log("info", msg) }
        )
        await this.tqueue.start()
        this.tqueue.on("task", async (task: TranscriptionTaskResponse) => {
            // if (task.type === "intermediate")
            //     return

            this.log("info", `received ${task.type} transcription #${task.id}: "${task.text}"`)

            // DEBUG
            // const wav = new wavefile.WaveFile()
            // wav.fromScratch(1, sampleRateTarget, "32f", task.audio)
            // const data = wav.toBuffer()
            // fs.writeFileSync(`chunk-out-${n++}.wav`, data)
        })

        /*  track audio queue element changes  */
        let speechActive      = false
        let speechStart       = -1
        let speechEnd         = -1
        let speechMinSeconds  = 2
        this.queue.on("write", () => {
            if (!speechActive) {
                const position = this.queueSTT.searchForward("speech-start")
                const element = this.queueSTT.peek(position)
                if (element !== undefined && element.type === "speech-start") {
                    this.queueSTT.position(position + 1)
                    speechActive     = true
                    speechStart      = this.queueSTT.position()
                    speechEnd        = speechStart
                    speechMinSeconds = 2
                }
            }
            else {
                speechEnd = this.queueSTT.searchForward("speech-end")

                /*   determine number of speech and fill frames  */
                let framesSpeech = 0
                for (let f = speechStart; f < speechEnd; f++) {
                    const element = this.queueSTT.peek(f)
                    if (element.type === "audio-frame")
                        framesSpeech++
                }
                let framesFilled = minFramesPerSecond - framesSpeech
                if (framesFilled < 0)
                    framesFilled = 0

                /*  assemble all speech and fill frames  */
                const assembleFrames = () => {
                    const speech = new Float32Array((framesSpeech + framesFilled) * samplesPerVADFrame)
                    let i = 0
                    for (let f = speechStart; f < speechEnd; f++) {
                        const element = this.queueSTT.peek(f)
                        if (element.type === "audio-frame")
                            speech.set(element.data, samplesPerVADFrame * i++)
                    }
                    if (framesFilled > 0)
                        speech.fill(0.0, i * samplesPerVADFrame, (i + framesFilled) * samplesPerVADFrame)

                    // DEBUG
                    // const wav = new wavefile.WaveFile()
                    // wav.fromScratch(1, sampleRateTarget, "32f", speech)
                    // const data = wav.toBuffer()
                    // fs.writeFileSync(`chunk-speech-${m++}.wav`, data)

                    return speech
                }

                if (speechEnd === this.queueSTT.maxPosition()) {
                    /*  intermediate transcription  */
                    const duration = ((framesSpeech + framesFilled) * samplesPerVADFrame) / sampleRateTarget
                    if (duration >= speechMinSeconds) {
                        /*  intermediate transcription of at least the next required minimum seconds  */
                        const samples = assembleFrames()
                        this.log("info", `trigger intermediate transcription (duration: ${duration.toFixed(1)}s)`)
                        this.tqueue!.enqueue({ id: speechStart, type: "intermediate", audio: samples, language: this.params.language })
                        speechMinSeconds++
                    }
                }
                else {
                    /*  final transcription  */
                    const duration = ((framesSpeech + framesFilled) * samplesPerVADFrame) / sampleRateTarget
                    if (duration >= 1.0) {
                        const samples = assembleFrames()
                        this.log("info", `trigger final transcription (duration: ${duration.toFixed(1)}s)`)
                        this.tqueue!.enqueue({ id: speechStart, type: "final", audio: samples, language: this.params.language })
                        this.queueSTT.position(speechEnd + 1)
                    }
                    else
                        this.log("info", `skipping final transcription -- too short (duration: ${duration.toFixed(1)}s)`)
                    speechActive = false
                }
            }
        })

        /*  Voice Activity Detection (VAD)  */
        this.vad = await RealTimeVAD.new({
            onSpeechStart: () => {
                this.log("info", "VAD: speech start")
                this.queueVAD.insert({ type: "speech-start" })
            },
            onSpeechEnd: (audio) => {
                this.log("info", `VAD: speech end (samples: ${audio.length})`)
                this.queueVAD.insert({ type: "speech-end", short: false })
            },
            onVADMisfire: () => {
                this.log("info", "VAD: speech end (segment too short)")
                this.queueVAD.insert({ type: "speech-end", short: true })
            },
            onFrameProcessed: () => {
                this.queueVAD.walk(+1)
            },
            sampleRate:              16000,
            model:                   "v5",
            frameSamples:            samplesPerVADFrame, /* (= 32ms: 512 frameSamples / 16000 sampleSize) */
            positiveSpeechThreshold: 0.50,
            negativeSpeechThreshold: 0.35,
            minSpeechFrames:         4,  /* (= 128ms: 4 x 512 frameSamples) */
            redemptionFrames:        8,  /* (= 256ms: 8 x 512 frameSamples) */
            preSpeechPadFrames:      1,  /* (= 32ms:  1 x 512 frameSamples) */
        })
        this.vad.start()

        /*  provide Duplex stream and internally attach to Ollama API  */
        const vad       = this.vad
        const cfg       = this.config
        const queueRecv = this.queueRecv
        let carrySamples = new Float32Array()
        let endOfStream = false
        this.stream = new Stream.Duplex({
            writableObjectMode: false,
            readableObjectMode: true,
            decodeStrings:      false,

            /*  receive audio samples  */
            write (chunk: Buffer, encoding, callback) {
                if (!Buffer.isBuffer(chunk))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16/48KHz to PCM/F32/16KHz  */
                    const bufferToInt16Array = (buf: Buffer): Int16Array => {
                        const dataView = new DataView(buf.buffer)
                        const result   = new Int16Array(buf.length / 2)
                        for (let i = 0; i < result.length; i++)
                            result[i] = dataView.getInt16(i * 2, cfg.audioLittleEndian)
                        return result
                    }
                    const wav = new wavefile.WaveFile()
                    wav.fromScratch(cfg.audioChannels, cfg.audioSampleRate,
                        String(cfg.audioBitDepth), bufferToInt16Array(chunk))
                    wav.toBitDepth("32f")
                    wav.toSampleRate(16000, { method: "cubic" })
                    let data = wav.getSamples(false, Float32Array) as any as Float32Array

                    /*  merge previous carry samples  */
                    if (carrySamples.length > 0) {
                        const merged = new Float32Array(carrySamples.length + data.length)
                        merged.set(carrySamples)
                        merged.set(data, carrySamples.length)
                        data = merged
                        carrySamples = new Float32Array()
                    }

                    /*  DEBUG  */
                    // const wav2 = new wavefile.WaveFile()
                    // wav2.fromScratch(1, sampleRateTarget, "32f", data)
                    // const data2 = wav.toBuffer()
                    // fs.writeFileSync(`chunk-in-${k++}.wav`, data2)

                    /*  queue audio samples as individual VAD-sized frames
                        and in parallel send it into the Voice Activity Detection (VAD)  */
                    const chunks = Math.trunc(data.length / samplesPerVADFrame)
                    for (let i = 0; i < chunks; i++) {
                        const frame = data.slice(i * samplesPerVADFrame, (i + 1) * samplesPerVADFrame)
                        queueRecv.append({ type: "audio-frame", data: frame })
                        vad.processAudio(frame)
                    }

                    /*  remember new carry samples  */
                    const bulkLen = chunks * samplesPerVADFrame
                    carrySamples = data.slice(bulkLen)

                    callback()
                }
            },

            /*  send transcription texts  */
            read (size) {
                if (endOfStream)
                    this.push(null)
                else {
                    queueOutput.once("text", (text: string) => {
                        log("info", `Whisper: receive data (${text.length} bytes)`)
                        this.push(text, cfg.textEncoding)
                    })
                }
            },

            /*  react on end of input  */
            final (callback) {
                if (carrySamples.length > 0) {
                    /*  flush pending audio samples  */
                    if (carrySamples.length < samplesPerVADFrame) {
                        const merged = new Float32Array(samplesPerVADFrame)
                        merged.set(carrySamples)
                        merged.fill(0.0, carrySamples.length, samplesPerVADFrame)
                        carrySamples = merged
                    }
                    queueRecv.append({ type: "audio-frame", data: carrySamples })
                    vad.processAudio(carrySamples)

                    /*  give the processing a chance to still process the remaining samples  */
                    setTimeout(() => {
                        endOfStream = true
                        this.push(null)
                        callback()
                    }, 2000)
                }
                else {
                    endOfStream = true
                    this.push(null)
                    callback()
                }
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  close VAD  */
        if (this.vad !== null) {
            await this.vad.flush()
            this.vad.destroy()
            this.vad = null
        }

        /*  close transcription queue  */
        if (this.tqueue !== null) {
            await this.tqueue.stop()
            this.tqueue = null
        }
    }
}
