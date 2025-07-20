/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

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
    private dg: Deepgram.LiveClient | null = null

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
        let balance  = 0
        const deepgram = Deepgram.createClient(this.params.keyAdm)
        const response = await deepgram.manage.getProjects()
        if (response !== null && response.error === null) {
            for (const project of response.result.projects) {
                const response = await deepgram.manage.getProjectBalances(project.project_id)
                if (response !== null && response.error === null)
                    balance += response.result.balances[0]?.amount ?? 0
            }
        }
        return { balance: balance.toFixed(2) }
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Deepgram node currently supports PCM-S16LE audio only")

        /*  create queue for results  */
        const queue = new utils.SingleQueue<SpeechFlowChunk>()

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
            const text = (data.channel?.alternatives[0]?.transcript as string) ?? ""
            if (text === "")
                this.log("info", `Deepgram: empty/dummy text received (start: ${data.start}s, duration: ${data.duration}s)`)
            else {
                this.log("info", `Deepgram: text received (start: ${data.start}s, duration: ${data.duration}s): "${text}"`)
                const start = Duration.fromMillis(data.start * 1000).plus(this.timeZeroOffset)
                const end   = start.plus({ seconds: data.duration })
                const metas = metastore.fetch(start, end)
                const meta = metas.reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                    curr.forEach((val, key) => { prev.set(key, val) })
                    return prev
                }, new Map<string, any>())
                metastore.prune(start)
                const chunk = new SpeechFlowChunk(start, end, "final", "text", text, meta)
                queue.write(chunk)
            }
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Metadata, (data) => {
            this.log("info", "Deepgram: metadata received")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Close, () => {
            this.log("info", "Deepgram: connection close")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Error, (error: Error) => {
            this.log("error", `Deepgram: ${error.message}`)
            this.emit("error")
        })

        /*  wait for Deepgram API to be available  */
        await new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                if (timer !== null) {
                    timer = null
                    reject(new Error("Deepgram: timeout waiting for connection open"))
                }
            }, 3000)
            this.dg!.once(Deepgram.LiveTranscriptionEvents.Open, () => {
                this.log("info", "Deepgram: connection open")
                if (timer !== null) {
                    clearTimeout(timer)
                    timer = null
                }
                resolve(true)
            })
        })

        /*  remember opening time to receive time zero offset  */
        this.timeOpen = DateTime.now()

        /*  workaround Deepgram initialization problems  */
        let initDone = false
        let initTimeout: ReturnType<typeof setTimeout> | null = null
        const initTimeoutStart = () => {
            if (initDone)
                return
            setTimeout(async () => {
                if (initTimeout === null)
                    return
                initTimeout = null
                this.log("warning", "Deepgram: initialization timeout -- restarting service usage")
                await this.close()
                this.open()
            }, 3000)
        }
        const initTimeoutStop = () => {
            if (initDone)
                return
            initDone = true
            if (initTimeout !== null) {
                clearTimeout(initTimeout)
                initTimeout = null
            }
        }

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const dg = this.dg
        const log = (level: string, msg: string) => {
            this.log(level, msg)
        }
        const encoding = this.config.textEncoding
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (chunk.type !== "audio")
                    callback(new Error("expected audio input chunk"))
                else if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected Buffer input chunk"))
                else {
                    if (chunk.payload.byteLength > 0) {
                        log("info", `Deepgram: send data (${chunk.payload.byteLength} bytes)`)
                        initTimeoutStart()
                        if (chunk.meta.size > 0)
                            metastore.store(chunk.timestampStart, chunk.timestampEnd, chunk.meta)
                        dg.send(chunk.payload.buffer) /* intentionally discard all time information  */
                    }
                    callback()
                }
            },
            read (size) {
                queue.read().then((chunk) => {
                    log("info", `Deepgram: receive data (${chunk.payload.length} bytes)`)
                    initTimeoutStop()
                    this.push(chunk, encoding)
                })
            },
            final (callback) {
                dg.requestClose()
                this.push(null)
                callback()
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

        /*  shutdown Deepgram API  */
        if (this.dg !== null)
            this.dg.requestClose()
    }
}
