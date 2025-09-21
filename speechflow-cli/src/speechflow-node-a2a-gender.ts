/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path    from "node:path"
import Stream  from "node:stream"

/*  external dependencies  */
import * as Transformers     from "@huggingface/transformers"
import { WaveFile }          from "wavefile"
import { getRMS, AudioData } from "audio-inspect"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  audio stream queue element */
type AudioQueueElement = {
    type:         "audio-frame",
    chunk:        SpeechFlowChunk,
    data:         Float32Array,
    gender?:      "male" | "female" | "unknown"
} | {
    type:         "audio-eof"
}

/*  SpeechFlow node for Gender recognition  */
export default class SpeechFlowNodeA2AGender extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-gender"

    /*  internal state  */
    private classifier: Transformers.AudioClassificationPipeline | null = null
    private queue     = new util.Queue<AudioQueueElement>()
    private queueRecv = this.queue.pointerUse("recv")
    private queueAC   = this.queue.pointerUse("ac")
    private queueSend = this.queue.pointerUse("send")
    private shutdown  = false
    private workingOffTimer:  ReturnType<typeof setTimeout>  | null = null
    private progressInterval: ReturnType<typeof setInterval> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            window:          { type: "number", pos: 0, val: 500  },
            threshold:       { type: "number", pos: 1, val: 0.50 },
            hysteresis:      { type: "number", pos: 2, val: 0.25 },
            volumeThreshold: { type: "number", pos: 3, val: -45  }
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

        /*  clear shutdown flag  */
        this.shutdown = false

        /*  the used model  */
        const model = "Xenova/wav2vec2-large-xlsr-53-gender-recognition-librispeech"

        /*  track download progress when instantiating Transformers engine and model  */
        const progressState = new Map<string, number>()
        const progressCallback: Transformers.ProgressCallback = (progress: any) => {
            if (this.shutdown)
                return
            let artifact = model
            if (typeof progress.file === "string")
                artifact += `:${progress.file}`
            let percent = 0
            if (typeof progress.loaded === "number" && typeof progress.total === "number")
                percent = (progress.loaded / progress.total) * 100
            else if (typeof progress.progress === "number")
                percent = progress.progress
            if (percent > 0)
                progressState.set(artifact, percent)
        }
        this.progressInterval = setInterval(() => {
            if (this.shutdown)
                return
            for (const [ artifact, percent ] of progressState) {
                this.log("info", `downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                if (percent >= 100.0)
                    progressState.delete(artifact)
            }
        }, 1000)
        try {
            const pipelinePromise = Transformers.pipeline("audio-classification", model, {
                cache_dir: path.join(this.config.cacheDir, "gender"),
                dtype:     "q4",
                device:    "auto",
                progress_callback: progressCallback
            })
            this.classifier = await Promise.race([
                pipelinePromise,
                util.timeoutPromise(30 * 1000, "model initialization timeout")
            ]) as Transformers.AudioClassificationPipeline
        }
        catch (error) {
            if (this.progressInterval) {
                clearInterval(this.progressInterval)
                this.progressInterval = null
            }
            throw new Error(`failed to initialize classifier pipeline: ${error}`, { cause: error })
        }
        if (this.progressInterval) {
            clearInterval(this.progressInterval)
            this.progressInterval = null
        }
        if (this.classifier === null)
            throw new Error("failed to instantiate classifier pipeline")

        /*  define sample rate required by model  */
        const sampleRateTarget = 16000

        /*  classify a single large-enough concatenated audio frame  */
        const classify = async (data: Float32Array) => {
            if (this.shutdown || this.classifier === null)
                throw new Error("classifier shutdown during operation")

            /*  check volume level and return "unknown" if too low
                in order to avoid a wrong classificaton  */
            const audioData = {
                sampleRate:       sampleRateTarget,
                numberOfChannels: 1,
                channelData:      [ data ],
                duration:         data.length / sampleRateTarget,
                length:           data.length
            } satisfies AudioData
            const rms = getRMS(audioData, { asDB: true })
            if (rms < this.params.volumeThreshold)
                return "unknown"

            /*  classify audio  */
            const result = await Promise.race([
                this.classifier(data),
                util.timeoutPromise(30 * 1000, "classification timeout")
            ]) as Transformers.AudioClassificationOutput | Transformers.AudioClassificationOutput[]
            const classified = Array.isArray(result) ?
                result as Transformers.AudioClassificationOutput :
                [ result ]
            const c1 = classified.find((c) => c.label === "male")
            const c2 = classified.find((c) => c.label === "female")
            const male   = c1 ? c1.score : 0.0
            const female = c2 ? c2.score : 0.0
            const threshold  = this.params.threshold
            const hysteresis = this.params.hysteresis
            if (male > threshold && male > female + hysteresis)
                return "male"
            else if (female > threshold && female > male + hysteresis)
                return "female"
            else
                return "unknown"
        }

        /*  work off queued audio frames  */
        const frameWindowDuration = this.params.window / 1000
        const frameWindowSamples  = Math.floor(frameWindowDuration * sampleRateTarget)
        let lastGender = ""
        let workingOff = false
        const workOffQueue = async () => {
            /*  control working off round  */
            if (workingOff || this.shutdown)
                return
            workingOff = true
            if (this.workingOffTimer !== null) {
                clearTimeout(this.workingOffTimer)
                this.workingOffTimer = null
            }
            this.queue.off("write", workOffQueue)

            /*  workoff the queue  */
            try {
                let pos0 = this.queueAC.position()
                const posL = this.queueAC.maxPosition()
                const data = new Float32Array(frameWindowSamples)
                data.fill(0)
                let samples = 0
                let pos = pos0
                while (pos < posL && samples < frameWindowSamples && !this.shutdown) {
                    const element = this.queueAC.peek(pos)
                    if (element === undefined || element.type !== "audio-frame")
                        break
                    if ((samples + element.data.length) < frameWindowSamples) {
                        data.set(element.data, samples)
                        samples += element.data.length
                    }
                    pos++
                }
                if (pos0 < pos && samples > frameWindowSamples * 0.75 && !this.shutdown) {
                    const gender = await classify(data)
                    if (this.shutdown)
                        return
                    const posM = pos0 + Math.trunc((pos - pos0) * 0.25)
                    while (pos0 < posM && pos0 < posL && !this.shutdown) {
                        const element = this.queueAC.peek(pos0)
                        if (element === undefined || element.type !== "audio-frame")
                            break
                        element.gender = gender
                        this.queueAC.touch()
                        this.queueAC.walk(+1)
                        pos0++
                    }
                    if (lastGender !== gender && !this.shutdown) {
                        this.log("info", `gender now recognized as <${gender}>`)
                        lastGender = gender
                    }
                }
            }
            catch (error) {
                this.log("error", `gender classification error: ${error}`)
            }

            /*  re-initiate working off round  */
            workingOff = false
            if (!this.shutdown) {
                this.workingOffTimer = setTimeout(workOffQueue, 100)
                this.queue.once("write", workOffQueue)
            }
        }
        this.queue.once("write", workOffQueue)

        /*  provide Duplex stream and internally attach to classifier  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  receive audio chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.shutdown) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    try {
                        /*  convert audio samples from PCM/I16/48KHz to PCM/F32/16KHz  */
                        let data = util.convertBufToF32(chunk.payload, self.config.audioLittleEndian)
                        const wav = new WaveFile()
                        wav.fromScratch(self.config.audioChannels, self.config.audioSampleRate, "32f", data)
                        wav.toSampleRate(sampleRateTarget, { method: "cubic" })
                        data = wav.getSamples(false, Float32Array) as any as Float32Array<ArrayBuffer>

                        /*  queue chunk and converted data  */
                        self.queueRecv.append({ type: "audio-frame", chunk, data })
                        callback()
                    }
                    catch (error) {
                        callback(error instanceof Error ? error : new Error("audio processing failed"))
                    }
                }
            },

            /*  receive no more audio chunks (writable side of stream)  */
            final (callback) {
                if (self.shutdown) {
                    callback()
                    return
                }

                /*  signal end of file  */
                self.queueRecv.append({ type: "audio-eof" })
                callback()
            },

            /*  send audio chunk(s) (readable side of stream)  */
            read (_size) {
                /*  flush pending audio chunks  */
                const flushPendingChunks = () => {
                    if (self.shutdown) {
                        this.push(null)
                        return
                    }
                    const element = self.queueSend.peek()
                    if (element !== undefined
                        && element.type === "audio-eof")
                        this.push(null)
                    else if (element !== undefined
                        && element.type === "audio-frame"
                        && element.gender !== undefined) {
                        while (true) {
                            if (self.shutdown) {
                                this.push(null)
                                return
                            }
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
                            const duration = util.audioArrayDuration(element.data)
                            self.log("debug", `send chunk (${duration.toFixed(3)}s) with gender <${element.gender}>`)
                            element.chunk.meta.set("gender", element.gender)
                            this.push(element.chunk)
                            self.queueSend.walk(+1)
                            self.queue.trim()
                        }
                    }
                    else if (!self.shutdown)
                        self.queue.once("write", flushPendingChunks)
                }
                flushPendingChunks()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate shutdown  */
        this.shutdown = true

        /*  cleanup working-off timer  */
        if (this.workingOffTimer !== null) {
            clearTimeout(this.workingOffTimer)
            this.workingOffTimer = null
        }

        /*  cleanup progress interval  */
        if (this.progressInterval !== null) {
            clearInterval(this.progressInterval)
            this.progressInterval = null
        }

        /*  remove all event listeners  */
        this.queue.removeAllListeners("write")

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  cleanup classifier  */
        if (this.classifier !== null) {
            try {
                const disposePromise = this.classifier.dispose()
                const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 5000))
                await Promise.race([ disposePromise, timeoutPromise ])
            }
            catch (error) {
                this.log("warning", `error during classifier cleanup: ${error}`)
            }
            this.classifier = null
        }

        /*  cleanup queue pointers  */
        this.queue.pointerDelete("recv")
        this.queue.pointerDelete("ac")
        this.queue.pointerDelete("send")
    }
}