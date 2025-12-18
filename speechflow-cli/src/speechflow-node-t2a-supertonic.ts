/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as Transformers  from "@huggingface/transformers"
import SpeexResampler     from "speex-resampler"
import { Duration }       from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Supertonic text-to-speech conversion  */
export default class SpeechFlowNodeT2ASupertonic extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-supertonic"

    /*  internal state  */
    private tts:       Transformers.TextToAudioPipeline | null = null
    private resampler: SpeexResampler                   | null = null
    private sampleRate                                         = 44100
    private closing                                            = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            voice: { type: "string", val: "M1", pos: 0, match: /^(?:M1|M2|F1|F2)$/ },
            speed: { type: "number", val: 1.40, pos: 1, match: (n: number) => n >= 0.5 && n <= 2.0 },
            steps: { type: "number", val: 20,   pos: 2, match: (n: number) => n >= 1   && n <= 20 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  one-time status of node  */
    async status () {
        return {}
    }

    /*  open node  */
    async open () {
        this.closing = false

        /*  load Supertonic TTS pipeline via transformers.js  */
        const model = "onnx-community/Supertonic-TTS-ONNX"
        this.log("info", `loading Supertonic TTS model "${model}"`)

        /*  track download progress  */
        const progressState = new Map<string, number>()
        const progressCallback = (progress: any) => {
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
        let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
            for (const [ artifact, percent ] of progressState) {
                this.log("info", `downloaded ${percent.toFixed(2)}% of artifact "${artifact}"`)
                if (percent >= 100.0)
                    progressState.delete(artifact)
            }
            if (progressState.size === 0 && interval !== null) {
                clearInterval(interval)
                interval = null
            }
        }, 1000)

        /*  create TTS pipeline  */
        try {
            const tts = Transformers.pipeline("text-to-speech", model, {
                dtype: "fp32",
                progress_callback: progressCallback
            })
            this.tts = await tts
        }
        finally {
            if (interval !== null) {
                clearInterval(interval)
                interval = null
            }
        }
        if (this.tts === null)
            throw new Error("failed to instantiate Supertonic TTS pipeline")

        /*  determine sample rate from model config  */
        const config = (this.tts as any).model?.config
        if (config?.sampling_rate)
            this.sampleRate = config.sampling_rate
        this.log("info", `loaded Supertonic TTS model (sample rate: ${this.sampleRate}Hz)`)

        /*  establish resampler from Supertonic's output sample rate to our standard audio sample rate (48kHz)  */
        this.resampler = new SpeexResampler(1, this.sampleRate, this.config.audioSampleRate, 7)

        /*  map voice names to speaker embedding URLs  */
        const voiceUrls: Record<string, string> = {
            "M1": "https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main/voices/M1.bin",
            "M2": "https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main/voices/M2.bin",
            "F1": "https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main/voices/F1.bin",
            "F2": "https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main/voices/F2.bin"
        }
        const speakerEmbeddings = voiceUrls[this.params.voice]
        if (speakerEmbeddings === undefined)
            throw new Error(`invalid Supertonic voice "${this.params.voice}"`)
        this.log("info", `using voice "${this.params.voice}"`)

        /*  perform text-to-speech operation with Supertonic  */
        const text2speech = async (text: string) => {
            this.log("info", `Supertonic: input: "${text}"`)

            /*  generate speech using transformers.js pipeline  */
            const result = await this.tts!(text, {
                speaker_embeddings:  speakerEmbeddings,
                num_inference_steps: this.params.steps,
                speed:               this.params.speed
            })

            /*  extract audio samples and sample rate  */
            if (!(result.audio instanceof Float32Array))
                throw new Error("unexpected Supertonic result: audio is not a Float32Array")
            if (typeof result.sampling_rate !== "number")
                throw new Error("unexpected Supertonic result: sampling_rate is not a number")
            const samples = result.audio
            const outputSampleRate = result.sampling_rate
            if (outputSampleRate !== this.sampleRate)
                this.log("warn", `unexpected sample rate ${outputSampleRate}Hz (expected ${this.sampleRate}Hz)`)

            /*  calculate duration  */
            const duration = samples.length / outputSampleRate
            this.log("info", `Supertonic: synthesized ${duration.toFixed(2)}s of audio`)

            /*  convert audio samples from PCM/F32 to PCM/I16  */
            const buffer1 = util.convertF32ToBuf(samples)

            /*  resample audio samples from Supertonic sample rate to 48kHz  */
            if (this.resampler === null)
                throw new Error("resampler destroyed during TTS processing")
            return this.resampler.processChunk(buffer1)
        }

        /*  create transform stream and connect it to the Supertonic TTS  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "")
                    callback()
                else {
                    let processTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                        processTimeout = null
                        callback(new Error("Supertonic TTS timeout"))
                    }, 120 * 1000)
                    const clearProcessTimeout = () => {
                        if (processTimeout !== null) {
                            clearTimeout(processTimeout)
                            processTimeout = null
                        }
                    }
                    text2speech(chunk.payload as string).then((buffer) => {
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        self.log("info", `Supertonic: received audio (buffer length: ${buffer.byteLength})`)

                        /*  calculate actual audio duration from PCM buffer size  */
                        const durationMs = util.audioBufferDuration(buffer,
                            self.config.audioSampleRate, self.config.audioBitDepth) * 1000

                        /*  create new chunk with recalculated timestamps  */
                        const chunkNew = chunk.clone()
                        chunkNew.type         = "audio"
                        chunkNew.payload      = buffer
                        chunkNew.timestampEnd = Duration.fromMillis(chunkNew.timestampStart.toMillis() + durationMs)
                        clearProcessTimeout()
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        clearProcessTimeout()
                        callback(util.ensureError(error, "Supertonic processing failed"))
                    })
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  destroy resampler  */
        if (this.resampler !== null)
            this.resampler = null

        /*  destroy TTS pipeline  */
        if (this.tts !== null) {
            /*  dispose of the pipeline if possible  */
            await this.tts.dispose()
            this.tts = null
        }
    }
}
