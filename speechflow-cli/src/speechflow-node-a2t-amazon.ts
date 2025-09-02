/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import {
    TranscribeStreamingClient,
    TranscriptResultStream,
    StartStreamTranscriptionCommand,
    type AudioStream,
    type LanguageCode
} from "@aws-sdk/client-transcribe-streaming"
import { DateTime, Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  helper class for an asynchronous queue  */
class AsyncQueue<T> {
    private queue: Array<T | null> = []
    private resolvers: ((it: IteratorResult<T>) => void)[] = []
    push (v: T | null) {
        const resolve = this.resolvers.shift()
        if (resolve) {
            if (v !== null)
                resolve({ value: v })
            else
                resolve({ value: null, done: true })
        }
        else
            this.queue.push(v)
    }
    destroy () {
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()
            resolve?.({ value: null, done: true })
        }
        this.queue.length = 0
    }
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true) {
            if (this.queue.length > 0) {
                const v = this.queue.shift()
                if (v === undefined || v === null)
                    return
                yield v
                continue
            }
            else {
                const it = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve))
                if (it.done)
                    return
                yield it.value
            }
        }
    }
}

/*  SpeechFlow node for Amazon Transcribe speech-to-text conversion  */
export default class SpeechFlowNodeA2TAmazon extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2t-amazon"

    /*  internal state  */
    private client:            TranscribeStreamingClient     | null             = null
    private clientStream:      AsyncIterable<TranscriptResultStream> | null     = null
    private destroyed                                                           = false
    private initTimeout:       ReturnType<typeof setTimeout> | null             = null
    private connectionTimeout: ReturnType<typeof setTimeout> | null             = null
    private queue:             utils.SingleQueue<SpeechFlowChunk | null> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",  val: process.env.SPEECHFLOW_AMAZON_KEY },
            secKey:   { type: "string",  val: process.env.SPEECHFLOW_AMAZON_KEY_SEC },
            region:   { type: "string",  val: "eu-central-1" },
            language: { type: "string",  val: "en", match: /^(?:de|en)$/ },
            interim:  { type: "boolean", val: false }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("AWS Access Key not configured")
        if (!this.params.secKey)
            throw new Error("AWS Secret Access Key not configured")

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
            throw new Error("Amazon Transcribe node currently supports PCM-S16LE audio only")

        /*  clear destruction flag  */
        this.destroyed = false

        /*  create queue for results  */
        this.queue = new utils.SingleQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        const metastore = new utils.TimeStore<Map<string, any>>()

        /*  connect to Amazon Transcribe API  */
        this.client = new TranscribeStreamingClient({
            region: this.params.region,
            credentials: {
                accessKeyId:     this.params.key,
                secretAccessKey: this.params.secKey
            }
        })
        if (this.client === null)
            throw new Error("failed to establish Amazon Transcribe client")

        /* create an AudioStream for Amazon Transcribe  */
        const audioQueue = new AsyncQueue<Uint8Array>()
        const audioStream = (async function *(q: AsyncQueue<Uint8Array>): AsyncIterable<AudioStream> {
            for await (const chunk of q) {
                yield { AudioEvent: { AudioChunk: chunk } }
            }
        })(audioQueue)

        /*  start streaming  */
        const ensureAudioStreamActive = async () => {
            if (this.clientStream !== null || this.destroyed)
                return
            const language: LanguageCode = this.params.language === "de" ? "de-DE" : "en-US"
            const command = new StartStreamTranscriptionCommand({
                LanguageCode: language,
                EnablePartialResultsStabilization: this.params.interim,
                ...(this.params.interim ? { PartialResultsStability: "low" } : {}),
                MediaEncoding: "pcm",
                MediaSampleRateHertz: this.config.audioSampleRate,
                AudioStream: audioStream,
            })
            const response = await this.client!.send(command)
            const stream = response.TranscriptResultStream
            if (!stream)
                throw new Error("no TranscriptResultStream returned")
            this.clientStream = stream
            ;(async () => {
                for await (const event of stream) {
                    const te = event.TranscriptEvent
                    if (!te?.Transcript?.Results)
                        continue
                    for (const result of te.Transcript.Results) {
                        const alt = result.Alternatives?.[0]
                        if (!alt?.Transcript)
                            continue
                        if (result.IsPartial && !this.params.interim)
                            continue
                        const text    = alt.Transcript ?? ""
                        const kind    = result.IsPartial ? "intermediate" : "final"
                        const tsStart = Duration.fromMillis((result.StartTime ?? 0) * 1000).plus(this.timeZeroOffset)
                        const tsEnd   = Duration.fromMillis((result.EndTime   ?? 0) * 1000).plus(this.timeZeroOffset)
                        const metas = metastore.fetch(tsStart, tsEnd)
                        const meta = metas.reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                            curr.forEach((val, key) => { prev.set(key, val) })
                            return prev
                        }, new Map<string, any>())
                        if (this.params.interim) {
                            const words = []
                            for (const item of alt.Items ?? []) {
                                if (item.Type === "pronunciation") {
                                    words.push({
                                        word:  item.Content,
                                        start: Duration.fromMillis((item.StartTime ?? 0) * 1000).plus(this.timeZeroOffset),
                                        end:   Duration.fromMillis((item.EndTime   ?? 0) * 1000).plus(this.timeZeroOffset)
                                    })
                                }
                            }
                            meta.set("words", words)
                        }
                        metastore.prune(tsStart)
                        const chunk = new SpeechFlowChunk(tsStart, tsEnd, kind, "text", text, meta)
                        this.queue?.write(chunk)
                    }
                }
            })().catch((err: Error) => {
                this.log("warning", `failed to establish connectivity to Amazon Transcribe: ${err}`)
            })
        }

        /*  remember opening time to receive time zero offset  */
        this.timeOpen = DateTime.now()

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed || self.client === null) {
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
                        audioQueue.push(new Uint8Array(chunk.payload)) /* intentionally discard all time information */
                        ensureAudioStreamActive().catch((error: unknown) => {
                            self.log("error", `failed to start audio stream: ${utils.ensureError(error).message}`)
                        })
                    }
                    callback()
                }
            },
            read (size) {
                if (self.destroyed || self.queue === null) {
                    this.push(null)
                    return
                }
                self.queue.read().then((chunk) => {
                    if (self.destroyed) {
                        this.push(null)
                        return
                    }
                    if (chunk === null) {
                        self.log("info", "received EOF signal")
                        this.push(null)
                    }
                    else {
                        self.log("debug", `received data (${chunk.payload.length} bytes): "${chunk.payload}"`)
                        this.push(chunk)
                    }
                }).catch((error: unknown) => {
                    if (!self.destroyed)
                        self.log("error", `queue read error: ${utils.ensureError(error).message}`)
                })
            },
            final (callback) {
                if (self.destroyed || self.client === null) {
                    callback()
                    return
                }
                utils.run(
                    () => self.client!.destroy(),
                    (error: Error) => self.log("warning", `error closing Amazon Transcribe connection: ${error}`)
                )
                audioQueue.push(null) /* do not push null to stream, let Amazon Transcribe do it */
                audioQueue.destroy()
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate destruction first to stop all async operations  */
        this.destroyed = true

        /*  cleanup all timers  */
        if (this.initTimeout !== null) {
            clearTimeout(this.initTimeout)
            this.initTimeout = null
        }
        if (this.connectionTimeout !== null) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
        }

        /*  close queue  */
        if (this.queue !== null) {
            this.queue.write(null)
            this.queue = null
        }

        /*  close Amazon Transcribe connection  */
        if (this.client !== null) {
            this.client.destroy()
            this.client = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
