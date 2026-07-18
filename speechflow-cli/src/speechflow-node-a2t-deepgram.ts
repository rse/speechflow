/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import * as Deepgram          from "@deepgram/sdk"
import { V1Socket }           from "@deepgram/sdk/listen/v1"
import { DateTime, Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  NOTICE: the connection arguments type is not publicly re-exported by the
    Deepgram SDK, so derive it structurally from the connect method instead  */
type DeepgramConnectArgs = Parameters<Deepgram.DeepgramClient["listen"]["v1"]["connect"]>[0]

/*  SpeechFlow node for Deepgram speech-to-text conversion  */
export default class SpeechFlowNodeA2TDeepgram extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2t-deepgram"

    /*  internal state  */
    private dg:                V1Socket                                 | null = null
    private closing                                                            = false
    private reconfiguring                                                      = false
    private connectionTimeout: ReturnType<typeof setTimeout>            | null = null
    private queue:             util.AsyncQueue<SpeechFlowChunk | null>  | null = null
    private metastore:         util.TimeStore<Map<string, any>>         | null = null
    private suspended                                                          = false
    private opening                                                            = false
    private openReject:        ((error: Error) => void)                 | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:         { type: "string",  val: process.env.SPEECHFLOW_DEEPGRAM_KEY },
            keyAdm:      { type: "string",  val: process.env.SPEECHFLOW_DEEPGRAM_KEY_ADM },
            model:       { type: "string",  val: "nova-2", pos: 0 },
            version:     { type: "string",  val: "latest", pos: 1 },
            language:    { type: "string",  val: "multi",  pos: 2 },
            interim:     { type: "boolean", val: false,    pos: 3 },
            endpointing: { type: "number",  val: 0,        pos: 4 },
            keywords:    { type: "string",  val: "",       pos: 5 },
            suspended:   { type: "boolean", val: false,    pos: 6 }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("Deepgram API key not configured")

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "text"
    }

    /*  receive external request  */
    async receiveRequest (params: any[]) {
        if (this.closing)
            throw new Error("deepgram: node already destroyed")
        try {
            if (params.length === 2 && params[0] === "suspended") {
                if (typeof params[1] !== "boolean")
                    throw new Error("deepgram: invalid suspended argument in external request")
                const suspended = params[1]
                await this.setSuspended(suspended)
                this.sendResponse([ "deepgram", "suspended", suspended ])
            }
            else
                throw new Error("deepgram: invalid arguments in external request")
        }
        catch (error) {
            this.log("error", `receive request error: ${error}`)
            throw error
        }
    }

    /*  change suspended flag  */
    async setSuspended (suspended: boolean) {
        if (this.closing) {
            this.log("warning", "attempted to set suspended flag on destroyed node")
            return
        }
        if (suspended === this.suspended)
            return
        this.log("info", `switching to ${suspended ? "SUSPENDED" : "UNSUSPENDED"} operation`)
        this.suspended = suspended
        if (suspended) {
            /*  going suspended -- tear down Deepgram API connection  */
            this.reconfiguring = true
            try {
                await this.closeConnection()
            }
            finally {
                this.reconfiguring = false
            }
        }
        else {
            /*  going unsuspended -- re-establish Deepgram API connection  */
            await this.openConnection()
        }
    }

    /*  open Deepgram API connection  */
    private async openConnection () {
        /*  configure Deepgram connection options  */
        const interim     = this.params.interim as boolean
        const endpointing = this.params.endpointing as number
        /*  NOTICE: the Deepgram API v5 SDK expects the boolean flags as their
            string representations, as they are passed as URL query parameters.
            The "filler_words" flag is a valid live API parameter, but is not
            covered by the generated SDK types, so pass it via "queryParams".  */
        const options: DeepgramConnectArgs = {
            /*  NOTICE: the Deepgram API v5 SDK applies the client-level "apiKey" only
                to its REST endpoints -- the WebSocket connect path never consults the
                authentication provider and instead requires the "Authorization" header
                to be passed explicitly, or else the server closes the handshake  */
            Authorization:    `Token ${this.params.key}`,
            mip_opt_out:      true,
            model:            this.params.model,
            version:          this.params.version,
            channels:         this.config.audioChannels,
            sample_rate:      this.config.audioSampleRate,
            encoding:         "linear16",
            multichannel:     "false",
            endpointing:      endpointing > 0 ? endpointing : "false",
            interim_results:  interim ? "true" : "false",
            smart_format:     "false",
            punctuate:        "true",
            numerals:         "false",
            diarize:          "false",
            profanity_filter: "false",
            redact:           "false",
            queryParams:      { filler_words: "true" }
        }
        const model    = this.params.model    as string
        const language = this.params.language as string
        const keywords = this.params.keywords as string
        if (model.match(/^nova-2/) && language !== "en")
            options.language = this.params.language
        else if (model.match(/^nova-3/) && language !== "en")
            options.language = "multi"
        else
            options.language = "en"
        if (keywords !== "") {
            if (model.match(/^nova-2/))
                options.keywords = keywords.split(/(?:\s+|\s*,\s*)/).map((kw) => {
                    let boost = 2
                    if (kw.startsWith("-")) {
                        kw = kw.slice(1)
                        boost = -4
                    }
                    return `${kw}:${boost}`
                })
            else if (model.match(/^nova-3/))
                options.keyterm = keywords.split(/(?:\s+|\s*,\s*)/).join(" ")
        }

        /*  connect to Deepgram API  */
        const deepgram = new Deepgram.DeepgramClient({ apiKey: this.params.key })
        this.dg = await deepgram.listen.v1.connect(options)

        /*  hook onto Deepgram API messages  */
        this.dg.on("message", (message: V1Socket.Response) => {
            if (this.closing || this.queue === null || this.metastore === null)
                return
            if (message.type === "SpeechStarted")
                this.log("info", "speech started", message)
            else if (message.type === "UtteranceEnd")
                this.log("info", "utterance end received", message)
            else if (message.type === "Metadata")
                this.log("info", "metadata received")
            else if (message.type === "Results") {
                const data  = message
                const text  = data.channel?.alternatives[0]?.transcript ?? ""
                const words = data.channel?.alternatives[0]?.words ?? []
                const isFinal     = data.is_final     ?? false
                const speechFinal = data.speech_final ?? false
                const kind = (isFinal || (endpointing > 0 && speechFinal)) ? "final" : "intermediate"
                if (text === "")
                    this.log("info", `empty/dummy text received (start: ${data.start}s, duration: ${data.duration.toFixed(2)}s)`)
                else {
                    this.log("info", `text received (start: ${data.start}s, ` +
                        `duration: ${data.duration.toFixed(2)}s, kind: ${kind}): ` +
                        `"${text}"`)
                    const start = Duration.fromMillis(data.start * 1000).plus(this.timeZeroOffset)
                    const end   = start.plus({ seconds: data.duration })
                    const metas = this.metastore.fetch(start, end)
                    const meta = metas.toReversed().reduce((prev: Map<string, any>, curr: Map<string, any>) => {
                        curr.forEach((val, key) => { prev.set(key, val) })
                        return prev
                    }, new Map<string, any>())
                    this.metastore.prune(start)
                    meta.set("words", words.map((word) => {
                        const start = Duration.fromMillis(word.start * 1000).plus(this.timeZeroOffset)
                        const end   = Duration.fromMillis(word.end * 1000).plus(this.timeZeroOffset)
                        return { word: word.punctuated_word ?? word.word, start, end }
                    }))
                    const chunk = new SpeechFlowChunk(start, end, kind, "text", text, meta)
                    this.queue.write(chunk)
                }
            }
        })
        this.dg.on("close", () => {
            this.log("info", "connection close")
            /*  NOTICE: suppress EOF signalling while reconfiguring (mute toggle),
                since the connection is being torn down deliberately and the
                graph must keep running  */
            if (!this.closing && !this.reconfiguring && this.queue !== null)
                this.queue.write(null)
        })

        /*  NOTICE: the Deepgram API socket supports only a single handler per
            event, so the open handshake and the permanent error handling must
            share one error handler which dispatches on the "opening" flag:
            during open, the error is routed solely into the caller's promise
            rejection, without a parallel stream emission tearing down the
            graph prematurely.  */
        this.dg.on("error", (error: Error) => {
            if (this.opening) {
                if (this.openReject !== null)
                    this.openReject(error)
                return
            }
            this.log("warning", `error: ${error.message}`)
            /*  NOTICE: do not write null to the queue here -- a transient error
                must not be misinterpreted as end-of-stream by downstream nodes;
                the subsequent Deepgram Close event will signal real EOF. Also
                do not emit("error") on the node itself, since nothing listens
                for it and it would become an uncaughtException tearing down
                the whole graph. Route via the stream instead, where it is
                downgraded to a warning by the graph supervisor.  */
            if (!this.closing && this.stream !== null)
                this.stream.emit("error", error)
        })

        /*  NOTICE: the Deepgram API v5 SDK returns a socket which has not yet
            dialed, as it is internally created with the "startClosed" option,
            so the connection has to be established explicitly -- and only once
            all event handlers above are registered, as the connect operation
            re-registers the underlying socket listeners  */
        this.dg.connect()

        /*  wait for Deepgram API to be available  */
        this.opening = true
        try {
            await new Promise((resolve, reject) => {
                this.openReject = reject
                this.connectionTimeout = setTimeout(() => {
                    if (this.connectionTimeout !== null) {
                        this.connectionTimeout = null
                        reject(new Error("Deepgram: timeout waiting for connection open"))
                    }
                }, 8000)
                this.dg!.waitForOpen().then(() => {
                    this.log("info", "connection open")
                    if (this.connectionTimeout !== null) {
                        clearTimeout(this.connectionTimeout)
                        this.connectionTimeout = null
                    }
                    resolve(true)
                }).catch((error: unknown) => {
                    if (this.connectionTimeout !== null) {
                        clearTimeout(this.connectionTimeout)
                        this.connectionTimeout = null
                    }
                    reject(util.ensureError(error, "failed to open Deepgram connection"))
                })
            })
        }
        finally {
            this.opening    = false
            this.openReject = null
        }
    }

    /*  close Deepgram API connection  */
    private async closeConnection () {
        /*  cleanup pending connection timer  */
        if (this.connectionTimeout !== null) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
        }

        /*  close Deepgram connection and remove listeners  */
        if (this.dg !== null) {
            try {
                this.dg.close()
                this.log("info", "connection closed")
            }
            catch (error) {
                this.log("warning", `error during Deepgram cleanup: ${error}`)
            }
            this.dg = null
        }
    }

    /*  one-time status of node  */
    async status () {
        let balance = 0
        try {
            const deepgram = new Deepgram.DeepgramClient({ apiKey: this.params.keyAdm })
            const response = await deepgram.manage.v1.projects.list()
            for (const project of response.projects ?? []) {
                if (project.project_id === undefined)
                    continue
                const balanceResponse = await deepgram.manage.v1.projects.billing.balances.list(project.project_id)
                balance += balanceResponse.balances?.[0]?.amount ?? 0
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
        this.closing = false

        /*  create queue for results  */
        this.queue = new util.AsyncQueue<SpeechFlowChunk | null>()

        /*  create a store for the meta information  */
        this.metastore = new util.TimeStore<Map<string, any>>()

        /*  determine initial suspended state from configuration  */
        this.suspended = this.params.suspended as boolean

        /*  establish Deepgram API connection (unless starting suspended)  */
        if (!this.suspended)
            await this.openConnection()

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
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (chunk.type !== "audio")
                    callback(new Error("expected audio input chunk"))
                else if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected Buffer input chunk"))
                else if (self.suspended || self.dg === null)
                    /*  drop audio entirely -- do not forward to Deepgram  */
                    callback()
                else {
                    if (chunk.payload.byteLength > 0) {
                        self.log("debug", `send data (${chunk.payload.byteLength} bytes)`)
                        if (chunk.meta.size > 0 && self.metastore !== null)
                            self.metastore.store(chunk.timestampStart, chunk.timestampEnd, chunk.meta)
                        try {
                            /*  send buffer (and intentionally discard all time information)  */
                            self.dg.sendMedia(chunk.payload)
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
                if (self.closing) {
                    callback()
                    return
                }

                /*  close Deepgram API  */
                if (self.dg !== null) {
                    try {
                        self.dg.close()
                    }
                    catch (error) {
                        self.log("warning", `error closing Deepgram connection: ${error}`)
                    }
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

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  close Deepgram API connection  */
        await this.closeConnection()

        /*  signal EOF to any pending read operations  */
        if (this.queue !== null) {
            this.queue.write(null)
            this.queue = null
        }

        /*  discard meta information store  */
        this.metastore = null
    }
}
