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

type wsPeerCtx = {
    peer: string
}
type wsPeerInfo = {
    ctx:        wsPeerCtx
    ws:         WebSocket
    req:        http.IncomingMessage
}
interface HapiWebSocketConnectArgs {
    ctx: wsPeerCtx
    ws:  WebSocket
    req: http.IncomingMessage
}
interface HapiWebSocketDisconnectArgs {
    ctx: wsPeerCtx
}

/*  SpeechFlow node for subtitle (text-to-text) "translations"  */
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
            mode:   { type: "string",          val: "export", match: /^(?:export|render)$/ },
            addr:   { type: "string",          val: "127.0.0.1" },
            port:   { type: "number",          val: 8585 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = this.params.mode === "export" ? "text" : "none"
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
                let output = ""
                if (this.params.words) {
                    output += convertSingle(chunk.timestampStart, chunk.timestampEnd, chunk.payload)
                    const words = (chunk.meta.get("words") ?? []) as
                        { word: string, start: Duration, end: Duration }[]
                    const occurrences = new Map<string, number>()
                    for (const word of words) {
                        let occurrence = occurrences.get(word.word) ?? 0
                        occurrence++
                        occurrences.set(word.word, occurrence)
                        output += convertSingle(word.start, word.end, chunk.payload, word.word, occurrence)
                    }
                }
                else
                    output += convertSingle(chunk.timestampStart, chunk.timestampEnd, chunk.payload)
                return output
            }

            /*  establish a duplex stream  */
            const self = this
            let firstChunk = true
            this.stream = new Stream.Transform({
                readableObjectMode: true,
                writableObjectMode: true,
                decodeStrings:      false,
                highWaterMark:      1,
                transform (chunk: SpeechFlowChunk, encoding, callback) {
                    if (firstChunk && self.params.format === "vtt") {
                        this.push(new SpeechFlowChunk(
                            Duration.fromMillis(0), Duration.fromMillis(0),
                            "final", "text",
                            "WEBVTT\n\n"
                        ))
                        firstChunk = false
                    }
                    if (Buffer.isBuffer(chunk.payload))
                        callback(new Error("invalid chunk payload type"))
                    else {
                        if (chunk.payload === "") {
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
                    }
                },
                final (callback) {
                    this.push(null)
                    callback()
                }
            })
        }
        else if (this.params.mode === "render") {
            /*  establish REST/WebSocket API  */
            const wsPeers = new Map<string, wsPeerInfo>()
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
                            connect: ({ ctx, ws, req }: HapiWebSocketConnectArgs) => {
                                const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
                                ctx.peer = peer
                                wsPeers.set(peer, { ctx, ws, req })
                                this.log("info", `HAPI: WebSocket: connect: peer ${peer}`)
                            },
                            disconnect: ({ ctx }: HapiWebSocketDisconnectArgs) => {
                                const peer = ctx.peer
                                wsPeers.delete(peer)
                                this.log("info", `HAPI: WebSocket: disconnect: peer ${peer}`)
                            }
                        }
                    }
                },
                handler: (request: HAPI.Request, h: HAPI.ResponseToolkit) =>
                    h.response({}).code(204)
            })

            await this.hapi.start()
            this.log("info", `HAPI: started REST/WebSocket network service: http://${this.params.addr}:${this.params.port}`)

            const emit = (chunk: SpeechFlowChunk) => {
                const data = JSON.stringify(chunk)
                for (const info of wsPeers.values())
                    info.ws.send(data)
            }

            this.stream = new Stream.Writable({
                objectMode:     true,
                decodeStrings:  false,
                highWaterMark:  1,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (Buffer.isBuffer(chunk.payload))
                        callback(new Error("invalid chunk payload type"))
                    else {
                        if (chunk.payload === "")
                            callback()
                        else {
                            emit(chunk)
                            callback()
                        }
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
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  shutdown HAPI  */
        if (this.hapi !== null) {
            await this.hapi.stop()
            this.hapi = null
        }
    }
}
