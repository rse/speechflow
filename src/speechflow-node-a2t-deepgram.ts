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
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for Deepgram speech-to-text conversion  */
export default class SpeechFlowNodeDeepgram extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "deepgram"

    /*  internal state  */
    private dg:                Deepgram.LiveClient | null                       = null
    private destroyed                                                           = false
    private initTimeout:       ReturnType<typeof setTimeout> | null             = null
    private connectionTimeout: ReturnType<typeof setTimeout> | null             = null
    private queue:             utils.SingleQueue<SpeechFlowChunk | null> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_DEEPGRAM_KEY },
            keyAdm:   { type: "string", val: process.env.SPEECHFLOW_DEEPGRAM_KEY_ADM },
            model:    { type: "string", val: "nova-3", pos: 0 },
            version:  { type: "string", val: "latest", pos: 1 },
            language: { type: "string", val: "multi",  pos: 2 }
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
            if (response !== null && response.error === null) {
                for (const project of response.result.projects) {
                    const response = await deepgram.manage.getProjectBalances(project.project_id)
                    if (response !== null && response.error === null)
                        balance += response.result.balances[0]?.amount ?? 0
                }
            }
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
        this.destroyed = false

        /*  create queue for results  */
        this.queue = new utils.SingleQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        const metastore = new utils.TimeStore<Map<string, any>>()

        /*  connect to Deepgram API  */
        const deepgram = Deepgram.createClient(this.params.key)
        let language = "en"
        if (this.params.model.match(/^nova-2/) && this.params.language !== "en")
            language = this.params.language
        else if (this.params.model.match(/^nova-3/) && this.params.language !== "en")
            language = "multi"
        this.dg = deepgram.listen.live({
            mip_opt_out:      true,
            model:            this.params.model,
            version:          this.params.version,
            language,
            channels:         this.config.audioChannels,
            sample_rate:      this.config.audioSampleRate,
            encoding:         "linear16",
            multichannel:     false,
            endpointing:      10,
            interim_results:  false,
            smart_format:     true,
            punctuate:        true,
            filler_words:     true,
            diarize:          false,
            numerals:         true,
            profanity_filter: false
        })

        /*  hook onto Deepgram API events  */
        this.dg.on(Deepgram.LiveTranscriptionEvents.Transcript, async (data) => {
            if (this.destroyed || this.queue === null)
                return
            const text  = (data.channel?.alternatives[0]?.transcript ?? "") as string
            const words = (data.channel?.alternatives[0]?.words ?? []) as
                { word: string, punctuated_word?: string, start: number, end: number }[]
            if (text === "")
                this.log("info", `empty/dummy text received (start: ${data.start}s, duration: ${data.duration.toFixed(2)}s)`)
            else {
                this.log("info", `text received (start: ${data.start}s, duration: ${data.duration.toFixed(2)}s): "${text}"`)
                const start = Duration.fromMillis(data.start * 1000).plus(this.timeZeroOffset)
                const end   = start.plus({ seconds: data.duration })
                const metas = metastore.fetch(start, end)
                const meta = metas.reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                    curr.forEach((val, key) => { prev.set(key, val) })
                    return prev
                }, new Map<string, any>())
                metastore.prune(start)
                meta.set("words", words.map((word) => {
                    const start = Duration.fromMillis(word.start * 1000).plus(this.timeZeroOffset)
                    const end   = Duration.fromMillis(word.end * 1000).plus(this.timeZeroOffset)
                    return { word: word.punctuated_word ?? word.word, start, end }
                }))
                const chunk = new SpeechFlowChunk(start, end, "final", "text", text, meta)
                this.queue.write(chunk)
            }
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Metadata, (data) => {
            this.log("info", "metadata received")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Close, () => {
            this.log("info", "connection close")
            if (!this.destroyed && this.queue !== null)
                this.queue.write(null)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Error, (error: Error) => {
            this.log("error", `error: ${error.message}`)
            if (!this.destroyed && this.queue !== null)
                this.queue.write(null)
            this.emit("error")
        })

        /*  wait for Deepgram API to be available  */
        await new Promise((resolve, reject) => {
            this.connectionTimeout = setTimeout(() => {
                if (this.connectionTimeout !== null) {
                    this.connectionTimeout = null
                    reject(new Error("Deepgram: timeout waiting for connection open"))
                }
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

        /*  workaround Deepgram initialization problems  */
        let initDone = false
        const initTimeoutStart = () => {
            if (initDone || this.destroyed)
                return
            this.initTimeout = setTimeout(async () => {
                if (this.initTimeout === null || this.destroyed)
                    return
                this.initTimeout = null
                this.log("warning", "initialization timeout -- restarting service usage")
                await this.close()
                if (!this.destroyed)
                    await this.open()
            }, 3 * 1000)
        }
        const initTimeoutStop = () => {
            if (initDone)
                return
            initDone = true
            if (this.initTimeout !== null) {
                clearTimeout(this.initTimeout)
                this.initTimeout = null
            }
        }

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed || self.dg === null) {
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
                        initTimeoutStart()
                        if (chunk.meta.size > 0)
                            metastore.store(chunk.timestampStart, chunk.timestampEnd, chunk.meta)
                        try {
                            self.dg.send(chunk.payload.buffer) /* intentionally discard all time information */
                        }
                        catch (error) {
                            callback(error instanceof Error ? error : new Error("failed to send to Deepgram"))
                            return
                        }
                    }
                    callback()
                }
            },
            read (size) {
                if (self.destroyed || self.queue === null) {
                    this.push(null)
                    return
                }
                let readTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                    if (readTimeout !== null) {
                        readTimeout = null
                        if (!self.destroyed) {
                            self.log("warning", "read timeout - pushing null to prevent hanging")
                            this.push(null)
                        }
                    }
                }, 30 * 1000)
                self.queue.read().then((chunk) => {
                    if (readTimeout !== null) {
                        clearTimeout(readTimeout)
                        readTimeout = null
                    }
                    if (self.destroyed) {
                        this.push(null)
                        return
                    }
                    if (chunk === null) {
                        self.log("info", "received EOF signal")
                        this.push(null)
                    }
                    else {
                        self.log("info", `received data (${chunk.payload.length} bytes)`)
                        initTimeoutStop()
                        this.push(chunk, self.config.textEncoding)
                    }
                }).catch((error) => {
                    if (readTimeout !== null) {
                        clearTimeout(readTimeout)
                        readTimeout = null
                    }
                    if (!self.destroyed) {
                        self.log("error", `queue read error: ${error.message}`)
                        this.push(null)
                    }
                })
            },
            final (callback) {
                if (self.destroyed || self.dg === null) {
                    callback()
                    return
                }
                try {
                    self.dg.requestClose()
                }
                catch (error) {
                    self.log("warning", `error closing Deepgram connection: ${error}`)
                }
                /*  NOTICE: do not push null here -- let the Deepgram close event handle it  */
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

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
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
