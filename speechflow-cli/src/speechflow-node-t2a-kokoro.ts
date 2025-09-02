/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { KokoroTTS }  from "kokoro-js"
import SpeexResampler from "speex-resampler"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for Kokoro text-to-speech conversion  */
export default class SpeechFlowNodeKokoro extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "kokoro"

    /*  internal state  */
    private kokoro: KokoroTTS | null = null
    private resampler: SpeexResampler | null = null
    private static speexInitialized = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            voice:    { type: "string", val: "Aoede", pos: 0, match: /^(?:Aoede|Heart|Puck|Fenrir)$/ },
            language: { type: "string", val: "en",    pos: 1, match: /^(?:en)$/ },
            speed:    { type: "number", val: 1.25,    pos: 2, match: (n: number) => n >= 1.0 && n <= 1.30 },
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  establish Kokoro  */
        const model = "onnx-community/Kokoro-82M-v1.0-ONNX"
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
        this.kokoro = await KokoroTTS.from_pretrained(model, {
            dtype: "q4f16",
            progress_callback: progressCallback
        })
        if (interval !== null) {
            clearInterval(interval)
            interval = null
        }
        if (this.kokoro === null)
            throw new Error("failed to instantiate Kokoro")

        /*  establish resampler from Kokoro's maximum 24Khz
            output to our standard audio sample rate (48KHz)  */
        if (!SpeechFlowNodeKokoro.speexInitialized) {
            /*  at least once initialize resampler  */
            SpeechFlowNodeKokoro.speexInitialized = true
            await SpeexResampler.initPromise
        }
        this.resampler = new SpeexResampler(1, 24000, this.config.audioSampleRate, 7)

        /*  determine voice for text-to-speech operation  */
        const voices: Record<string, string> = {
            "Aoede":  "af_aoede",
            "Heart":  "af_heart",
            "Puck":   "am_puck",
            "Fenrir": "am_fenrir"
        }
        const voice = voices[this.params.voice]
        if (voice === undefined)
            throw new Error(`invalid Kokoro voice "${this.params.voice}"`)

        /*  perform text-to-speech operation with Kokoro API  */
        const text2speech = async (text: string) => {
            this.log("info", `Kokoro: input: "${text}"`)
            const audio = await this.kokoro!.generate(text, {
                speed: this.params.speed,
                voice: voice as any
            })
            if (audio.sampling_rate !== 24000)
                throw new Error("expected 24KHz sampling rate in Kokoro output")

            /*  convert audio samples from PCM/F32/24Khz to PCM/I16/24KHz  */
            const samples = audio.audio
            const buffer1 = Buffer.alloc(samples.length * 2)
            for (let i = 0; i < samples.length; i++) {
                const sample = Math.max(-1, Math.min(1, samples[i]))
                buffer1.writeInt16LE(sample * 0x7FFF, i * 2)
            }

            /*  resample audio samples from PCM/I16/24Khz to PCM/I16/48KHz  */
            const buffer2 = this.resampler!.processChunk(buffer1)

            return buffer2
        }

        /*  create transform stream and connect it to the Kokoro API  */
        const log = (level: string, msg: string) => { this.log(level, msg) }
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    text2speech(chunk.payload).then((buffer) => {
                        log("info", `Kokoro: received audio (buffer length: ${buffer.byteLength})`)
                        chunk = chunk.clone()
                        chunk.type = "audio"
                        chunk.payload = buffer
                        this.push(chunk)
                        callback()
                    }).catch((error: unknown) => {
                        callback(utils.ensureError(error))
                    })
                }
            },
            final (callback) {
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  destroy stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  destroy resampler  */
        if (this.resampler !== null)
            this.resampler = null

        /*  destroy Kokoro API  */
        if (this.kokoro !== null)
            this.kokoro = null
    }
}

