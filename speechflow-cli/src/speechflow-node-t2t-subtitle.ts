/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path          from "node:path"
import http          from "node:http"
import Stream        from "node:stream"

/*  external dependencies  */
import { Duration }  from "luxon"
import * as HAPI     from "@hapi/hapi"
import Inert         from "@hapi/inert"
import WebSocket     from "ws"
import HAPIWebSocket from "hapi-plugin-websocket"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  internal helper types  */
type WSPeerInfo = {
    ctx:   Record<string, any>
    ws:    WebSocket
    req:   http.IncomingMessage
}
type TextChunk = {
    start: Duration
    end:   Duration
    text:  string
}

/*  SpeechFlow node for subtitle (text-to-text) conversions  */
export default class SpeechFlowNodeT2TSubtitle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-subtitle"

    /*  internal state  */
    private sequenceNo = 1
    private hapi: HAPI.Server | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            format: { type: "string",  pos: 0, val: "srt",    match: /^(?:srt|vtt)$/ },
            words:  { type: "boolean",         val: false },
            mode:   { type: "string",          val: "export", match: /^(?:export|import|render)$/ },
            addr:   { type: "string",          val: "127.0.0.1" },
            port:   { type: "number",          val: 8585 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = (this.params.mode === "export" || this.params.mode === "import") ? "text" : "none"
    }

    /*  open node  */
    async open () {
        if (this.params.mode === "export") {
            this.sequenceNo = 1

            /*  provide text-to-subtitle conversion  */
            const convert = async (chunk: SpeechFlowChunk) => {
                if (typeof chunk.payload !== "string")
                    throw new Error("chunk payload type must be string")
                const convertSingle = (
                    start:       Duration,
                    end:         Duration,
                    text:        string,
                    word?:       string,
                    occurrence?: number
                ) => {
                    if (word) {
                        occurrence ??= 1
                        let match = 1
                        word = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                        text = text.replaceAll(new RegExp(`\\b${word}\\b`, "g"), (m) => {
                            if (match++ === occurrence)
                                return `<b>${m}</b>`
                            else
                                return m
                        })
                    }
                    if (this.params.format === "srt") {
                        const startFmt = start.toFormat("hh:mm:ss,SSS")
                        const endFmt   = end.toFormat("hh:mm:ss,SSS")
                        text = `${this.sequenceNo++}\n` +
                            `${startFmt} --> ${endFmt}\n` +
                            `${text}\n\n`
                    }
                    else if (this.params.format === "vtt") {
                        const startFmt = start.toFormat("hh:mm:ss.SSS")
                        const endFmt   = end.toFormat("hh:mm:ss.SSS")
                        text = `${startFmt} --> ${endFmt}\n` +
                            `${text}\n\n`
                    }
                    return text
                }

                /*  determine start and end timestamp,
                    by using first word's start time and last word's end time (if available),
                    to exclude leading and trailing silence parts  */
                const words: { word: string, start: Duration, end: Duration }[] = chunk.meta.get("words") ?? []
                const timestampStart = words.length > 0 ? words[0].start              : chunk.timestampStart
                const timestampEnd   = words.length > 0 ? words[words.length - 1].end : chunk.timestampEnd

                /*  produce SRT/VTT blocks  */
                let output = convertSingle(timestampStart, timestampEnd, chunk.payload)
                if (this.params.words) {
                    /*  produce additional SRT/VTT blocks with each word highlighted  */
                    const occurrences = new Map<string, number>()
                    for (const word of words) {
                        let occurrence = occurrences.get(word.word) ?? 0
                        occurrence++
                        occurrences.set(word.word, occurrence)
                        output += convertSingle(word.start, word.end, chunk.payload, word.word, occurrence)
                    }
                }
                return output
            }

            /*  establish a duplex stream  */
            const self = this
            let headerEmitted = false
            this.stream = new Stream.Transform({
                readableObjectMode: true,
                writableObjectMode: true,
                decodeStrings:      false,
                highWaterMark:      1,
                transform (chunk: SpeechFlowChunk, encoding, callback) {
                    if (!headerEmitted && self.params.format === "vtt") {
                        this.push(new SpeechFlowChunk(
                            Duration.fromMillis(0), Duration.fromMillis(0),
                            "final", "text",
                            "WEBVTT\n\n"
                        ))
                        headerEmitted = true
                    }
                    if (Buffer.isBuffer(chunk.payload))
                        callback(new Error("invalid chunk payload type"))
                    else if (chunk.payload === "") {
                        this.push(chunk)
                        callback()
                    }
                    else {
                        convert(chunk).then((payload) => {
                            const chunkNew = chunk.clone()
                            chunkNew.payload = payload
                            this.push(chunkNew)
                            callback()
                        }).catch((error: unknown) => {
                            callback(util.ensureError(error))
                        })
                    }
                },
                final (callback) {
                    callback()
                }
            })
        }
        else if (this.params.mode === "import") {
            /*  parse timestamp in SRT format ("HH:MM:SS,mmm") or VTT format ("HH:MM:SS.mmm")  */
            const parseTimestamp = (ts: string): Duration => {
                const match = ts.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/)
                if (!match)
                    throw new Error(`invalid timestamp format: "${ts}"`)
                const hours        = Number.parseInt(match[1], 10)
                const minutes      = Number.parseInt(match[2], 10)
                const seconds      = Number.parseInt(match[3], 10)
                const milliseconds = Number.parseInt(match[4], 10)
                if (minutes > 59 || seconds > 59)
                    throw new Error(`invalid timestamp value "${ts}"`)
                return Duration.fromObject({ hours, minutes, seconds, milliseconds })
            }

            /*  strip arbitrary HTML tags  */
            const stripHtmlTags = (text: string): string =>
                text.replace(/<\/?[a-zA-Z][^>]*>/g, "")

            /*  parse SRT format  */
            const parseSRT = (input: string): TextChunk[] => {
                const results: TextChunk[] = []

                /*  iterate over all blocks  */
                const blocks = input.trim().split(/\r?\n\r?\n+/)
                for (const block of blocks) {
                    const lines = block.trim().split(/\r?\n/)
                    if (lines.length < 2) {
                        this.log("warning", "SRT block contains fewer than 2 lines")
                        continue
                    }

                    /*  skip optional sequence number line (first line)  */
                    let lineIdx = 0
                    if (/^\d+$/.test(lines[0].trim()))
                        lineIdx = 1

                    /*  parse timestamp line  */
                    const timeLine  = lines[lineIdx]
                    const timeMatch = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/)
                    if (!timeMatch) {
                        this.log("warning", "SRT contains invalid timestamp line")
                        continue
                    }
                    const start = parseTimestamp(timeMatch[1])
                    const end   = parseTimestamp(timeMatch[2])

                    /*  collect text lines  */
                    const textLines = lines.slice(lineIdx + 1).join("\n")
                    const text = stripHtmlTags(textLines).trim()
                    if (text !== "")
                        results.push({ start, end, text })
                }
                return results
            }

            /*  parse VTT format  */
            const parseVTT = (input: string): TextChunk[] => {
                const results: TextChunk[] = []

                /*  remove VTT header and any metadata  */
                const content = input.trim().replace(/^WEBVTT[^\r\n]*\r?\n*/, "")

                /*  iterate over all blocks  */
                const blocks = content.trim().split(/\r?\n\r?\n+/)
                for (const block of blocks) {
                    const lines = block.trim().split(/\r?\n/)
                    if (lines.length < 1) {
                        this.log("warning", "VTT block contains fewer than 1 line")
                        continue
                    }

                    /*  skip optional cue identifier lines  */
                    let lineIdx = 0
                    while (lineIdx < lines.length && !lines[lineIdx].includes("-->"))
                        lineIdx++
                    if (lineIdx >= lines.length)
                        continue

                    /*  parse timestamp line  */
                    const timeLine  = lines[lineIdx]
                    const timeMatch = timeLine.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/)
                    if (!timeMatch) {
                        this.log("warning", "VTT contains invalid timestamp line")
                        continue
                    }
                    const start = parseTimestamp(timeMatch[1])
                    const end   = parseTimestamp(timeMatch[2])

                    /*  collect text lines  */
                    const textLines = lines.slice(lineIdx + 1).join("\n")
                    const text = stripHtmlTags(textLines).trim()
                    if (text !== "")
                        results.push({ start, end, text })
                }
                return results
            }

            /*  buffer for accumulating input  */
            let buffer = ""

            /*  establish a duplex stream  */
            const self = this
            this.stream = new Stream.Transform({
                readableObjectMode: true,
                writableObjectMode: true,
                decodeStrings:      false,
                highWaterMark:      1,
                transform (chunk: SpeechFlowChunk, encoding, callback) {
                    /*  sanity check text chunks  */
                    if (Buffer.isBuffer(chunk.payload)) {
                        callback(new Error("invalid chunk payload type"))
                        return
                    }

                    /*  short-circuit processing in case of empty payloads  */
                    if (chunk.payload === "") {
                        this.push(chunk)
                        callback()
                        return
                    }

                    /*  accumulate input  */
                    buffer += chunk.payload

                    /*  parse accumulated input  */
                    try {
                        /*  parse entries  */
                        const entries = (self.params.format === "srt" ? parseSRT(buffer) : parseVTT(buffer))

                        /*  emit parsed entries as individual chunks  */
                        for (const entry of entries) {
                            const chunkNew = new SpeechFlowChunk(entry.start, entry.end, "final", "text", entry.text)
                            this.push(chunkNew)
                        }

                        /*  clear buffer after successful parse  */
                        buffer = ""
                        callback()
                    }
                    catch (error: unknown) {
                        buffer = ""
                        callback(util.ensureError(error))
                    }
                },
                final (callback) {
                    /*  process any remaining buffer content  */
                    if (buffer.trim() !== "") {
                        util.shield(() => {
                            /*  parse entries  */
                            const entries = self.params.format === "srt" ? parseSRT(buffer) : parseVTT(buffer)

                            /*  emit parsed entries as individual chunks  */
                            for (const entry of entries) {
                                const chunkNew = new SpeechFlowChunk(entry.start, entry.end, "final", "text", entry.text)
                                this.push(chunkNew)
                            }
                        })
                    }
                    callback()
                }
            })
        }
        else if (this.params.mode === "render") {
            /*  establish REST/WebSocket API  */
            const wsPeers = new Map<string, WSPeerInfo>()
            this.hapi = new HAPI.Server({
                address: this.params.addr,
                port:    this.params.port
            })
            await this.hapi.register({ plugin: Inert })
            await this.hapi.register({ plugin: HAPIWebSocket })
            this.hapi.events.on({ name: "request", channels: [ "error" ] }, (request: HAPI.Request, event: HAPI.RequestEvent, tags: { [key: string]: true }) => {
                if (event.error instanceof Error)
                    this.log("error", `HAPI: request-error: ${event.error.message}`)
                else
                    this.log("error", `HAPI: request-error: ${event.error}`)
            })
            this.hapi.events.on("log", (event: HAPI.LogEvent, tags: { [key: string]: true }) => {
                if (tags.error) {
                    const err = event.error
                    if (err instanceof Error)
                        this.log("error", `HAPI: log: ${err.message}`)
                    else
                        this.log("error", `HAPI: log: ${err}`)
                }
            })
            this.hapi.route({
                method: "GET",
                path: "/{param*}",
                handler: {
                    directory: {
                        path: path.join(__dirname, "../../speechflow-ui-st/dst"),
                        redirectToSlash: true,
                        index: true
                    }
                }
            })
            this.hapi.route({
                method: "POST",
                path:   "/api",
                options: {
                    payload: {
                        output: "data",
                        parse:  true,
                        allow:  "application/json"
                    },
                    plugins: {
                        websocket: {
                            autoping: 30 * 1000,
                            connect: ({ ctx, ws, req }) => {
                                const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
                                ctx.peer = peer
                                wsPeers.set(peer, { ctx, ws, req })
                                this.log("info", `HAPI: WebSocket: connect: peer ${peer}`)
                            },
                            disconnect: ({ ctx, ws }) => {
                                const peer = ctx.peer
                                wsPeers.delete(peer)
                                ws.removeAllListeners()
                                if (ws.readyState === WebSocket.OPEN)
                                    ws.close()
                                this.log("info", `HAPI: WebSocket: disconnect: peer ${peer}`)
                            }
                        }
                    }
                },
                handler: (request: HAPI.Request, h: HAPI.ResponseToolkit) =>
                    h.response({}).code(204)
            })

            /*  start HAPI server  */
            await this.hapi.start()
            this.log("info", `HAPI: started REST/WebSocket network service: http://${this.params.addr}:${this.params.port}`)

            /*  helper to emit chunks to WebSocket peers  */
            const emit = (chunk: SpeechFlowChunk) => {
                const data = JSON.stringify(chunk)
                for (const info of wsPeers.values())
                    info.ws.send(data)
            }

            /*  establish writable stream  */
            this.stream = new Stream.Writable({
                objectMode:     true,
                decodeStrings:  false,
                highWaterMark:  1,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (Buffer.isBuffer(chunk.payload))
                        callback(new Error("invalid chunk payload type"))
                    else if (chunk.payload === "")
                        callback()
                    else {
                        emit(chunk)
                        callback()
                    }
                },
                final (callback) {
                    callback()
                }
            })
        }
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  shutdown HAPI  */
        if (this.hapi !== null) {
            await this.hapi.stop()
            this.hapi = null
        }
    }
}
