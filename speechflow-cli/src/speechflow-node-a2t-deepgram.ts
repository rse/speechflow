/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as Deepgram          from "@deepgram/sdk"
import { DateTime, Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Deepgram speech-to-text conversion  */
export default class SpeechFlowNodeA2TDeepgram extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2t-deepgram"

    /*  internal state  */
    private dg:                Deepgram.LiveClient                        | null = null
    private closing                                                              = false
    private initTimeout:       ReturnType<typeof setTimeout>              | null = null
    private connectionTimeout: ReturnType<typeof setTimeout>              | null = null
    private queue:             util.SingleQueue<SpeechFlowChunk | null>   | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",  val: process.env.SPEECHFLOW_DEEPGRAM_KEY },
            keyAdm:   { type: "string",  val: process.env.SPEECHFLOW_DEEPGRAM_KEY_ADM },
            model:    { type: "string",  val: "nova-2", pos: 0 },
            version:  { type: "string",  val: "latest", pos: 1 },
            language: { type: "string",  val: "multi",  pos: 2 },
            interim:  { type: "boolean", val: false,    pos: 3 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "text"
    }

    /*  one-time status of node  */
    async status () {
        let balance = 0
        try {
            const deepgram = Deepgram.createClient(this.params.keyAdm)
            const response = await deepgram.manage.getProjects()
            if (response !== null && response.error === null && response.result?.projects) {
                for (const project of response.result.projects) {
                    const balanceResponse = await deepgram.manage.getProjectBalances(project.project_id)
                    if (balanceResponse !== null && balanceResponse.error === null && balanceResponse.result?.balances)
                        balance += balanceResponse.result.balances[0]?.amount ?? 0
                }
            }
            else if (response?.error !== null)
                this.log("warning", `API error fetching projects: ${response.error}`)
        }
        catch (error) {
            this.log("warning", `failed to fetch balance: ${error}`)
        }
        return { balance: balance.toFixed(2) }
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Deepgram node currently supports PCM-S16LE audio only")

        /*  clear destruction flag  */
        this.closing = false

        /*  create queue for results  */
        this.queue = new util.SingleQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        const metastore = new util.TimeStore<Map<string, any>>()

        /*  connect to Deepgram API  */
        const deepgram = Deepgram.createClient(this.params.key)
        let language = "en"
        if (this.params.language !== "en") {
            if (this.params.model.match(/^nova-2/))
                language = this.params.language
            else if (this.params.model.match(/^nova-3/))
                language = "multi"
        }
        this.dg = deepgram.listen.live({
            mip_opt_out:      true,
            model:            this.params.model,
            version:          this.params.version,
            language,
            channels:         this.config.audioChannels,
            sample_rate:      this.config.audioSampleRate,
            encoding:         "linear16",
            multichannel:     false,
            endpointing:      false,
            interim_results:  this.params.interim,
            smart_format:     true,
            punctuate:        true,
            filler_words:     true,
            numerals:         true,
            diarize:          false,
            profanity_filter: false,
            redact:           false
        })

        /*  hook onto Deepgram API events  */
        this.dg.on(Deepgram.LiveTranscriptionEvents.Transcript, async (data) => {
            if (this.closing || this.queue === null)
                return
            const text  = (data.channel?.alternatives[0]?.transcript ?? "") as string
            const words = (data.channel?.alternatives[0]?.words ?? []) as
                { word: string, punctuated_word?: string, start: number, end: number }[]
            const isFinal = (data.is_final ?? false) as boolean
            if (text === "")
                this.log("info", `empty/dummy text received (start: ${data.start}s, duration: ${data.duration.toFixed(2)}s)`)
            else {
                this.log("info", `text received (start: ${data.start}s, ` +
                    `duration: ${data.duration.toFixed(2)}s, ` +
                    `kind: ${isFinal ? "final" : "intermediate"}): ` +
                    `"${text}"`)
                const start = Duration.fromMillis(data.start * 1000).plus(this.timeZeroOffset)
                const end   = start.plus({ seconds: data.duration })
                const metas = metastore.fetch(start, end)
                const meta = metas.toReversed().reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                    curr.forEach((val, key) => { prev.set(key, val) })
                    return prev
                }, new Map<string, any>())
                metastore.prune(start)
                meta.set("words", words.map((word) => {
                    const start = Duration.fromMillis(word.start * 1000).plus(this.timeZeroOffset)
                    const end   = Duration.fromMillis(word.end * 1000).plus(this.timeZeroOffset)
                    return { word: word.punctuated_word ?? word.word, start, end }
                }))
                const chunk = new SpeechFlowChunk(start, end,
                    isFinal ? "final" : "intermediate", "text", text, meta)
                this.queue.write(chunk)
            }
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.SpeechStarted, (data) => {
            this.log("info", "speech started", data)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.UtteranceEnd, (data) => {
            this.log("info", "utterance end received", data)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Metadata, (data) => {
            this.log("info", "metadata received")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Close, () => {
            this.log("info", "connection close")
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Error, (error: Error) => {
            this.log("error", `error: ${error.message}`)
            if (!this.closing && this.queue !== null)
                this.queue.write(null)
            this.emit("error")
        })

        /*  wait for Deepgram API to be available  */
        await new Promise((resolve, reject) => {
            this.connectionTimeout = setTimeout(() => {
                this.connectionTimeout = null
                reject(new Error("Deepgram: timeout waiting for connection open"))
            }, 8000)
            this.dg!.once(Deepgram.LiveTranscriptionEvents.Open, () => {
                this.log("info", "connection open")
                if (this.connectionTimeout !== null) {
                    clearTimeout(this.connectionTimeout)
                    this.connectionTimeout = null
                }
                resolve(true)
            })
        })

        /*  remember opening time to receive time zero offset  */
        this.timeOpen = DateTime.now()

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const self = this
        const reads = new util.PromiseSet<void>()
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing || self.dg === null) {
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
                            self.dg.send(chunk.payload.buffer) /* intentionally discard all time information */
                        }
                        catch (error) {
                            callback(util.ensureError(error, "failed to send to Deepgram"))
                            return
                        }
                    }
                    callback()
                }
            },
            async final (callback) {
                /*  short-circuiting in case of own closing  */
                if (self.closing || self.dg === null) {
                    callback()
                    return
                }

                /*  close Deepgram API  */
                try {
                    self.dg.requestClose()
                }
                catch (error) {
                    self.log("warning", `error closing Deepgram connection: ${error}`)
                }

                /*  await all read operations  */
                await reads.awaitAll()

                /*  NOTICE: do not push null here -- let the Deepgram close event handle it  */
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
        if (this.initTimeout !== null) {
            clearTimeout(this.initTimeout)
            this.initTimeout = null
        }
        if (this.connectionTimeout !== null) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  close Deepgram connection and remove listeners  */
        if (this.dg !== null) {
            try {
                this.dg.removeAllListeners()
                this.dg.requestClose()
            }
            catch (error) {
                this.log("warning", `error during Deepgram cleanup: ${error}`)
            }
            this.dg = null
        }

        /*  signal EOF to any pending read operations  */
        if (this.queue !== null) {
            this.queue.write(null)
            this.queue = null
        }
    }
}
