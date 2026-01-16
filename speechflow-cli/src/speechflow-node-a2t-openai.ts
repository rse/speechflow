/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import OpenAI                 from "openai"
import { DateTime, Duration } from "luxon"
import SpeexResampler         from "speex-resampler"
import ws                     from "ws"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for OpenAI speech-to-text conversion  */
export default class SpeechFlowNodeA2TOpenAI extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2t-openai"

    /*  internal state  */
    private openai:            OpenAI                                    | null = null
    private ws:                ws.WebSocket                              | null = null
    private queue:             util.SingleQueue<SpeechFlowChunk | null>  | null = null
    private resampler:         SpeexResampler                            | null = null
    private closing                                                             = false
    private connectionTimeout: ReturnType<typeof setTimeout>             | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",  val: process.env.SPEECHFLOW_OPENAI_KEY },
            api:      { type: "string",  val: "https://api.openai.com/v1", match: /^https?:\/\/.+/ },
            model:    { type: "string",  val: "gpt-4o-mini-transcribe" },
            language: { type: "string",  val: "de", match: /^(?:en|de)$/ },
            interim:  { type: "boolean", val: false }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("OpenAI API key not configured")

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
            throw new Error("OpenAI transcribe node currently supports PCM-S16LE audio only")

        /*  clear destruction flag  */
        this.closing = false

        /*  create queue for results  */
        this.queue = new util.SingleQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        const metastore = new util.TimeStore<Map<string, any>>()

        /*  establish resampler from our standard audio sample rate (48Khz)
            to OpenAI's maximum 24Khz input sample rate  */
        this.resampler = new SpeexResampler(1, this.config.audioSampleRate, 24000, 7)

        /*  instantiate OpenAI API  */
        this.openai = new OpenAI({
            baseURL: this.params.api,
            apiKey:  this.params.key,
            dangerouslyAllowBrowser: true
        })

        /*  open the WebSocket connection for streaming  */
        const url = `${this.params.api.replace(/^http/, "ws")}/realtime?intent=transcription`
        this.ws = new ws.WebSocket(url, {
            headers: {
                Authorization: `Bearer ${this.params.key}`,
                "OpenAI-Beta": "realtime=v1"
            }
        })
        const sendMessage = (obj: any) => {
            this.ws?.send(JSON.stringify(obj))
        }

        /*  wait for OpenAI API to be available  */
        await new Promise((resolve, reject) => {
            this.connectionTimeout = setTimeout(() => {
                if (this.connectionTimeout !== null) {
                    this.connectionTimeout = null
                    reject(new Error("OpenAI: timeout waiting for connection open"))
                }
            }, 8000)
            this.ws!.once("open", () => {
                this.log("info", "connection open")
                if (this.connectionTimeout !== null) {
                    clearTimeout(this.connectionTimeout)
                    this.connectionTimeout = null
                }
                resolve(true)
            })
            this.ws!.once("error", (err) => {
                if (this.connectionTimeout !== null) {
                    clearTimeout(this.connectionTimeout)
                    this.connectionTimeout = null
                }
                reject(err)
            })
        })

        /*  configure session  */
        sendMessage({
            type: "transcription_session.update",
            session: {
                input_audio_format: "pcm16",
                input_audio_transcription: {
                    model:    this.params.model,
                    language: this.params.language
                },
                turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500
                }
            }
        })

        /*  hook onto session events  */
        this.ws.on("open", () => {
            this.log("info", "WebSocket connection opened")
            sendMessage({ type: "transcription.create" })
        })
        this.ws.on("close", () => {
            this.log("info", "WebSocket connection closed")
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
        })
        this.ws.on("error", (err) => {
            this.log("error", `WebSocket connection error: ${err}`)
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
            this.emit("error", err)
        })

        /*  track speech timing by item_id (OpenAI provides timestamps via VAD events)  */
        const speechTiming = new Map<string, { startMs: number, endMs: number }>()

        /*  helper function for aggregating meta information  */
        const aggregateMeta = (start: Duration, end: Duration): Map<string, any> => {
            const metas = metastore.fetch(start, end)
            return metas.toReversed().reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                curr.forEach((val, key) => { prev.set(key, val) })
                return prev
            }, new Map<string, any>())
        }

        /*  track transcription text  */
        let text = ""
        this.ws.on("message", (data) => {
            let ev: Record<string, unknown>
            try {
                ev = JSON.parse(data.toString()) as Record<string, unknown>
            }
            catch (err) {
                this.log("warning", `failed to parse WebSocket message: ${err}`)
                return
            }
            if (!(typeof ev === "object" && ev !== null)) {
                this.log("warning", "received invalid WebSocket message")
                return
            }
            switch (ev.type) {
                case "transcription_session.created":
                    break
                case "conversation.item.created": {
                    text = ""
                    break
                }
                case "conversation.item.input_audio_transcription.delta": {
                    text += ev.delta as string
                    if (this.params.interim && !this.closing && this.queue !== null) {
                        const itemId = ev.item_id as string
                        const timing = speechTiming.get(itemId)
                        const start  = timing !== undefined ? Duration.fromMillis(timing.startMs) : DateTime.now().diff(this.timeOpen!)
                        const end    = timing !== undefined ? Duration.fromMillis(timing.endMs)   : start
                        const chunk  = new SpeechFlowChunk(start, end, "intermediate", "text", text)
                        chunk.meta = aggregateMeta(start, end)
                        this.queue.write(chunk)
                    }
                    break
                }
                case "conversation.item.input_audio_transcription.completed": {
                    if (!this.closing && this.queue !== null) {
                        text = ev.transcript as string
                        const itemId = ev.item_id as string
                        const timing = speechTiming.get(itemId)
                        const start  = timing !== undefined ? Duration.fromMillis(timing.startMs) : DateTime.now().diff(this.timeOpen!)
                        const end    = timing !== undefined ? Duration.fromMillis(timing.endMs)   : start
                        const chunk  = new SpeechFlowChunk(start, end, "final", "text", text)
                        chunk.meta = aggregateMeta(start, end)
                        metastore.prune(start)
                        speechTiming.delete(itemId)
                        this.queue.write(chunk)
                        text = ""
                    }
                    break
                }
                case "input_audio_buffer.speech_started": {
                    this.log("info", "VAD: speech started")
                    const itemId = ev.item_id as string
                    const audioStartMs = ev.audio_start_ms as number
                    speechTiming.set(itemId, { startMs: audioStartMs, endMs: audioStartMs })
                    break
                }
                case "input_audio_buffer.speech_stopped": {
                    this.log("info", "VAD: speech stopped")
                    const itemId = ev.item_id as string
                    const audioEndMs = ev.audio_end_ms as number
                    const timing = speechTiming.get(itemId)
                    if (timing !== undefined)
                        timing.endMs = audioEndMs
                    break
                }
                case "input_audio_buffer.committed": {
                    this.log("info", "input buffer committed")
                    break
                }
                case "error": {
                    const error = ev.error as { message?: string } | undefined
                    this.log("error", `error: ${error?.message ?? "unknown error"}`)
                    break
                }
                default:
                    break
            }
        })

        /*  remember opening time to receive time zero offset  */
        this.timeOpen = DateTime.now()

        /*  provide Duplex stream and internally attach to OpenAI API  */
        const self = this
        const reads = new util.PromiseSet<void>()
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing || self.ws === null) {
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
                            const payload = self.resampler!.processChunk(chunk.payload)
                            const audioB64 = payload.toString("base64")
                            sendMessage({
                                type: "input_audio_buffer.append",
                                audio: audioB64 /* intentionally discard all time information */
                            })
                        }
                        catch (error) {
                            callback(util.ensureError(error, "failed to send to OpenAI transcribe"))
                            return
                        }
                    }
                    callback()
                }
            },
            async final (callback) {
                if (self.closing || self.ws === null) {
                    callback()
                    return
                }
                try {
                    sendMessage({ type: "input_audio_buffer.commit" })
                    self.ws.close()
                    await util.sleep(50)
                }
                catch (error) {
                    self.log("warning", `error closing OpenAI connection: ${error}`)
                }
                await reads.awaitAll()
                const chunks: Array<SpeechFlowChunk | null> = self.queue?.drain() ?? []
                for (const chunk of chunks)
                    this.push(chunk)
                this.push(null)
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

        /*  clear connection timeout  */
        if (this.connectionTimeout !== null) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
        }

        /*  signal EOF to any pending read operations  */
        if (this.queue !== null) {
            this.queue.write(null)
            this.queue = null
        }

        /*  close OpenAI connection  */
        if (this.ws !== null) {
            this.ws.removeAllListeners()
            this.ws.close()
            this.ws = null
        }
        if (this.openai !== null)
            this.openai = null

        /*  close resampler  */
        this.resampler = null

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
