/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as GoogleSpeech      from "@google-cloud/speech"
import { DateTime, Duration } from "luxon"
import * as arktype           from "arktype"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Google Cloud speech-to-text conversion  */
export default class SpeechFlowNodeA2TGoogle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2t-google"

    /*  internal state  */
    private client:            GoogleSpeech.SpeechClient                                   | null = null
    private recognizeStream:   ReturnType<GoogleSpeech.SpeechClient["streamingRecognize"]> | null = null
    private connectionTimeout: ReturnType<typeof setTimeout>                               | null = null
    private queue:             util.SingleQueue<SpeechFlowChunk | null>                    | null = null
    private closing                                                                               = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",          val: process.env.SPEECHFLOW_GOOGLE_KEY ?? "" },
            model:    { type: "string",  pos: 0, val: "latest_long" },
            language: { type: "string",  pos: 1, val: "en-US" },
            interim:  { type: "boolean", pos: 2, val: false }
        })

        /*  validate API key  */
        if (this.params.key === "")
            throw new Error("Google Cloud API credentials JSON key is required")

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "text"
    }

    /*  one-time status of node  */
    async status () {
        return {}
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Google Speech node currently supports PCM-S16LE audio only")

        /*  clear destruction flag  */
        this.closing = false

        /*  create queue for results  */
        this.queue = new util.SingleQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        const metastore = new util.TimeStore<Map<string, any>>()

        /*  instantiate Google Speech client  */
        const data = util.run("Google Cloud API credentials key", () =>
            JSON.parse(this.params.key))
        const credentials = util.importObject("Google Cloud API credentials key",
            data,
            arktype.type({
                project_id:   "string",
                private_key:  "string",
                client_email: "string"
            })
        )
        this.client = new GoogleSpeech.SpeechClient({
            credentials: {
                private_key:  credentials.private_key,
                client_email: credentials.client_email
            },
            projectId: credentials.project_id
        })

        /*  create streaming recognition request  */
        this.recognizeStream = this.client.streamingRecognize({
            config: {
                encoding:                   "LINEAR16",
                sampleRateHertz:            this.config.audioSampleRate,
                languageCode:               this.params.language,
                model:                      this.params.model,
                enableAutomaticPunctuation: true,
                enableWordTimeOffsets:      true
            },
            interimResults: this.params.interim
        })

        /*  hook onto Google Speech API events  */
        this.recognizeStream.on("data", (data: GoogleSpeech.protos.google.cloud.speech.v1.IStreamingRecognizeResponse) => {
            if (this.closing || this.queue === null)
                return
            if (!data.results || data.results.length === 0)
                return
            for (const result of data.results) {
                if (!result.alternatives || result.alternatives.length === 0)
                    continue
                const alternative = result.alternatives[0]
                const text = alternative.transcript ?? ""
                if (text === "")
                    continue
                const isFinal = result.isFinal ?? false
                if (!isFinal && !this.params.interim)
                    continue

                /*  calculate timestamps  */
                let tsStart = Duration.fromMillis(0)
                let tsEnd   = Duration.fromMillis(0)

                /*  extract word timing information if available  */
                const words: { word: string, start: Duration, end: Duration }[] = []
                if (alternative.words && alternative.words.length > 0) {
                    for (const wordInfo of alternative.words) {
                        const wordStart = wordInfo.startTime
                            ? Duration.fromMillis(
                                (Number(wordInfo.startTime.seconds ?? 0) * 1000) +
                                (Number(wordInfo.startTime.nanos ?? 0) / 1000000)
                            ).plus(this.timeZeroOffset)
                            : Duration.fromMillis(0)
                        const wordEnd = wordInfo.endTime
                            ? Duration.fromMillis(
                                (Number(wordInfo.endTime.seconds ?? 0) * 1000) +
                                (Number(wordInfo.endTime.nanos ?? 0) / 1000000)
                            ).plus(this.timeZeroOffset)
                            : Duration.fromMillis(0)
                        words.push({
                            word:  wordInfo.word ?? "",
                            start: wordStart,
                            end:   wordEnd
                        })
                    }
                    if (words.length > 0) {
                        tsStart = words[0].start
                        tsEnd   = words[words.length - 1].end
                    }
                }
                else {
                    /*  fallback: use result timing  */
                    const resultEnd = result.resultEndTime
                    if (resultEnd) {
                        tsEnd = Duration.fromMillis(
                            (Number(resultEnd.seconds ?? 0) * 1000) +
                            (Number(resultEnd.nanos ?? 0) / 1000000)
                        ).plus(this.timeZeroOffset)
                    }
                }
                this.log("info", `text received (start: ${tsStart.toMillis()}ms, ` +
                    `end: ${tsEnd.toMillis()}ms, ` +
                    `kind: ${isFinal ? "final" : "intermediate"}): ` +
                    `"${text}"`)

                /*  fetch and merge meta information  */
                const metas = metastore.fetch(tsStart, tsEnd)
                const meta = metas.toReversed().reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                    curr.forEach((val, key) => { prev.set(key, val) })
                    return prev
                }, new Map<string, any>())
                metastore.prune(tsStart)

                /*  add word timing to meta  */
                if (words.length > 0)
                    meta.set("words", words)

                /*  create and enqueue chunk  */
                const chunk = new SpeechFlowChunk(tsStart, tsEnd,
                    isFinal ? "final" : "intermediate", "text", text, meta)
                this.queue.write(chunk)
            }
        })
        this.recognizeStream.on("error", (error: Error) => {
            this.log("error", `error: ${error.message}`)
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
            this.emit("error", error)
        })
        this.recognizeStream.on("end", () => {
            this.log("info", "stream ended")
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
        })

        /*  remember opening time to receive time zero offset  */
        this.timeOpen = DateTime.now()

        /*  provide Duplex stream and internally attach to Google Speech API  */
        const self = this
        const reads = new util.PromiseSet<void>()
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing || self.recognizeStream === null) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (chunk.type !== "audio")
                    callback(new Error("expected audio input chunk"))
                else if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected Buffer input chunk"))
                else {
                    if (chunk.payload.byteLength > 0) {
                        self.log("debug", `send data (${chunk.payload.byteLength} bytes)`)
                        if (chunk.meta.size > 0)
                            metastore.store(chunk.timestampStart, chunk.timestampEnd, chunk.meta)
                        try {
                            self.recognizeStream.write(chunk.payload)
                        }
                        catch (error) {
                            callback(util.ensureError(error, "failed to send to Google Speech"))
                            return
                        }
                    }
                    callback()
                }
            },
            async final (callback) {
                /*  short-circuiting in case of own closing  */
                if (self.closing || self.recognizeStream === null) {
                    callback()
                    return
                }

                /*  close Google Speech stream  */
                try {
                    self.recognizeStream.end()
                }
                catch (error) {
                    self.log("warning", `error closing Google Speech stream: ${error}`)
                }

                /*  await all read operations  */
                await reads.awaitAll()
                callback()
            },
            read (size) {
                if (self.closing || self.queue === null) {
                    this.push(null)
                    return
                }
                reads.add(self.queue.read().then((chunk) => {
                    if (self.closing || self.queue === null) {
                        this.push(null)
                        return
                    }
                    if (chunk === null) {
                        self.log("info", "received EOF signal")
                        this.push(null)
                    }
                    else {
                        self.log("debug", `received data (${chunk.payload.length} bytes)`)
                        this.push(chunk)
                    }
                }).catch((error: unknown) => {
                    if (!self.closing && self.queue !== null)
                        self.log("error", `queue read error: ${util.ensureError(error).message}`)
                }))
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing first to stop all async operations  */
        this.closing = true

        /*  cleanup all timers  */
        if (this.connectionTimeout !== null) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  close Google Speech stream and client  */
        if (this.recognizeStream !== null) {
            try {
                this.recognizeStream.removeAllListeners()
                this.recognizeStream.destroy()
            }
            catch (error) {
                this.log("warning", `error during Google Speech stream cleanup: ${error}`)
            }
            this.recognizeStream = null
        }
        if (this.client !== null) {
            try {
                await this.client.close()
            }
            catch (error) {
                this.log("warning", `error closing Google Speech client: ${error}`)
            }
            this.client = null
        }

        /*  signal EOF to any pending read operations  */
        if (this.queue !== null) {
            this.queue.write(null)
            this.queue = null
        }
    }
}
