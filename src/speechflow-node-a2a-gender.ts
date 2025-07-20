/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path               from "node:path"
import Stream             from "node:stream"

/*  external dependencies  */
import * as Transformers  from "@huggingface/transformers"
import { WaveFile }       from "wavefile"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  audio stream queue element */
type AudioQueueElement = {
    type:         "audio-frame",
    chunk:        SpeechFlowChunk,
    data:         Float32Array,
    gender?:      "male" | "female"
} | {
    type:         "audio-eof"
}

/*  SpeechFlow node for Gender recognition  */
export default class SpeechFlowNodeGender extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "gender"

    /*  internal state  */
    private static speexInitialized = false
    private classifier: Transformers.AudioClassificationPipeline | null = null
    private queue     = new utils.Queue<AudioQueueElement>()
    private queueRecv = this.queue.pointerUse("recv")
    private queueAC   = this.queue.pointerUse("ac")
    private queueSend = this.queue.pointerUse("send")

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            window: { type: "number", pos: 0, val: 500 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Gender node currently supports PCM-S16LE audio only")

        /*  pass-through logging  */
        const log = (level: string, msg: string) => { this.log(level, msg) }

        /*  the used model  */
        const model = "Xenova/wav2vec2-large-xlsr-53-gender-recognition-librispeech"

        /*  track download progress when instantiating Transformers engine and model  */
        const progressState = new Map<string, number>()
        const progressCallback: Transformers.ProgressCallback = (progress: any) => {
            let artifact = model
            if (typeof progress.file === "string")
                artifact += `:${progress.file}`
            let percent = 0
            if (typeof progress.loaded === "number" && typeof progress.total === "number")
                percent = (progress.loaded as number / progress.total as number) * 100
            else if (typeof progress.progress === "number")
                percent = progress.progress
            if (percent > 0)
                progressState.set(artifact, percent)
        }
        const interval = setInterval(() => {
            for (const [ artifact, percent ] of progressState) {
                this.log("info", `downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                if (percent >= 1.0)
                    progressState.delete(artifact)
            }
        }, 1000)

        /*  instantiate Transformers engine and model  */
        const pipeline = Transformers.pipeline("audio-classification", model, {
            cache_dir: path.join(this.config.cacheDir, "gender"),
            dtype:     "q4",
            device:    "auto",
            progress_callback: progressCallback
        })
        this.classifier = await pipeline
        clearInterval(interval)
        if (this.classifier === null)
            throw new Error("failed to instantiate classifier pipeline")

        /*  classify a single large-enough concatenated audio frame  */
        const classify = async (data: Float32Array) => {
            const result = await this.classifier!(data)
            console.log(result)
            const classified: Transformers.AudioClassificationOutput =
                Array.isArray(result) ? result as Transformers.AudioClassificationOutput : [ result ]
            const c1 = classified.find((c: any) => c.label === "male")
            const c2 = classified.find((c: any) => c.label === "female")
            const male   = c1 ? c1.score : 0.0
            const female = c2 ? c2.score : 0.0
            return (male > female ? "male" : "female")
        }

        /*  work off queued audio frames  */
        const frameWindowDuration = 0.5
        const frameWindowSamples  = frameWindowDuration * this.config.audioSampleRate
        let lastGender = ""
        let workingOffTimer: ReturnType<typeof setTimeout> | null = null
        let workingOff = false
        const workOffQueue = async () => {
            /*  control working off round  */
            if (workingOff)
                return
            workingOff = true
            if (workingOffTimer !== null) {
                clearTimeout(workingOffTimer)
                workingOffTimer = null
            }

            let pos0 = this.queueAC.position()
            const posL = this.queueAC.maxPosition()
            const data = new Float32Array(frameWindowSamples)
            data.fill(0)
            let samples = 0
            let pos = pos0
            while (pos < posL && samples < frameWindowSamples) {
                const element = this.queueAC.peek(pos)
                if (element === undefined || element.type !== "audio-frame")
                    break
                if ((samples + element.data.length) < frameWindowSamples) {
                    data.set(element.data, samples)
                    samples += element.data.length
                }
                pos++
            }
            if (pos0 < pos && samples > frameWindowSamples * 0.75) {
                const gender = await classify(data)
                const posM = pos0 + Math.trunc((pos - pos0) * 0.25)
                while (pos0 < posM && pos0 < posL) {
                    const element = this.queueAC.peek(pos0)
                    if (element === undefined || element.type !== "audio-frame")
                        break
                    element.gender = gender
                    this.queueAC.touch()
                    this.queueAC.walk(+1)
                    pos0++
                }
                if (lastGender !== gender) {
                    log("info", `gender now recognized as <${gender}>`)
                    lastGender = gender
                }
            }

            /*  re-initiate working off round  */
            workingOff = false
            workingOffTimer = setTimeout(() => { workOffQueue() }, 100)
            this.queue.once("write", () => { workOffQueue() })
        }
        this.queue.once("write", () => { workOffQueue() })

        /*  define sample rate required by model  */
        const sampleRateTarget = 16000

        /*  provide Duplex stream and internally attach to classifier  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,

            /*  receive audio chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16/48KHz to PCM/F32/16KHz  */
                    let data = utils.convertBufToF32(chunk.payload, self.config.audioLittleEndian)
                    const wav = new WaveFile()
                    wav.fromScratch(self.config.audioChannels, self.config.audioSampleRate, "32f", data)
                    wav.toSampleRate(sampleRateTarget, { method: "cubic" })
                    data = wav.getSamples(false, Float32Array<ArrayBuffer>) as
                        any as Float32Array<ArrayBuffer>

                    /*  queue chunk and converted data  */
                    self.queueRecv.append({ type: "audio-frame", chunk, data })

                    callback()
                }
            },

            /*  receive no more audio chunks (writable side of stream)  */
            final (callback) {
                /*  signal end of file  */
                self.queueRecv.append({ type: "audio-eof" })
                callback()
            },

            /*  send audio chunk(s) (readable side of stream)  */
            read (_size) {
                /*  flush pending audio chunks  */
                const flushPendingChunks = () => {
                    while (true) {
                        const element = self.queueSend.peek()
                        if (element === undefined)
                            break
                        else if (element.type === "audio-eof") {
                            this.push(null)
                            break
                        }
                        else if (element.type === "audio-frame"
                            && element.gender === undefined)
                            break
                        const duration = utils.audioArrayDuration(element.data)
                        log("info", `send chunk (${duration.toFixed(3)}s) with gender <${element.gender}>`)
                        element.chunk.meta.set("gender", element.gender)
                        this.push(element.chunk)
                        self.queueSend.walk(+1)
                        self.queue.trim()
                    }
                }

                /*  await forthcoming audio chunks  */
                const awaitForthcomingChunks = () => {
                    const element = self.queueSend.peek()
                    if (element !== undefined
                        && element.type === "audio-frame"
                        && element.gender !== undefined)
                        flushPendingChunks()
                    else
                        self.queue.once("write", awaitForthcomingChunks)
                }

                const element = self.queueSend.peek()
                if (element !== undefined && element.type === "audio-eof")
                    this.push(null)
                else if (element !== undefined
                    && element.type === "audio-frame"
                    && element.gender !== undefined)
                    flushPendingChunks()
                else
                    self.queue.once("write", awaitForthcomingChunks)
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

        /*  close classifier  */
        if (this.classifier !== null) {
            this.classifier.dispose()
            this.classifier = null
        }
    }
}
