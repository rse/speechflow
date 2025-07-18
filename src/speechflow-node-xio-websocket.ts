/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                          from "node:stream"

/*  external dependencies  */
import ws                              from "ws"
import ReconnWebSocket, { ErrorEvent } from "@opensumi/reconnecting-websocket"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for Websocket networking  */
export default class SpeechFlowNodeWebsocket extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "websocket"

    /*  internal state  */
    private server: ws.WebSocketServer | null = null
    private client: ReconnWebSocket    | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            listen:  { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+))$/ },
            connect: { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/ },
            mode:    { type: "string", val: "r",    match: /^(?:r|w|rw)$/ },
            type:    { type: "string", val: "text", match: /^(?:audio|text)$/ }
        })

        /*  declare node input/output format  */
        if (this.params.mode === "rw") {
            this.input  = this.params.type
            this.output = this.params.type
        }
        else if (this.params.mode === "r") {
            this.input  = "none"
            this.output = this.params.type
        }
        else if (this.params.mode === "w") {
            this.input  = this.params.type
            this.output = "none"
        }
    }

    /*  open node  */
    async open () {
        /*  sanity check usage  */
        if (this.params.listen !== "" && this.params.connect !== "")
            throw new Error("Websocket node cannot listen and connect at the same time")
        else if (this.params.listen === "" && this.params.connect === "")
            throw new Error("Websocket node requires either listen or connect mode")

        if (this.params.listen !== "") {
            /*  listen locally on a Websocket port  */
            const url = new URL(this.params.listen)
            const websockets = new Set<ws.WebSocket>()
            const chunkQueue = new utils.SingleQueue<SpeechFlowChunk>()
            const server = new ws.WebSocketServer({
                host: url.hostname,
                port: Number.parseInt(url.port),
                path: url.pathname
            })
            server.on("listening", () => {
                this.log("info", `listening on URL ${this.params.listen}`)
            })
            server.on("connection", (ws, request) => {
                const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`
                this.log("info", `connection opened on URL ${this.params.listen} by peer ${peer}`)
                websockets.add(ws)
                ws.on("close", () => {
                    this.log("info", `connection closed on URL ${this.params.listen} by peer ${peer}`)
                    websockets.delete(ws)
                })
                ws.on("error", (error) => {
                    this.log("error", `error of connection on URL ${this.params.listen} for peer ${peer}: ${error.message}`)
                })
                ws.on("message", (data, isBinary) => {
                    if (this.params.mode === "w") {
                        this.log("warning", `connection on URL ${this.params.listen} by peer ${peer}: ` +
                            "received remote data on write-only node")
                        return
                    }
                    if (!isBinary) {
                        this.log("warning", `connection on URL ${this.params.listen} by peer ${peer}: ` +
                            "received non-binary message")
                        return
                    }
                    let buffer: Buffer
                    if (Buffer.isBuffer(data))
                        buffer = data
                    else if (data instanceof ArrayBuffer)
                        buffer = Buffer.from(data)
                    else
                        buffer = Buffer.concat(data)
                    const chunk = utils.streamChunkDecode(buffer)
                    chunkQueue.write(chunk)
                })
            })
            server.on("error", (error) => {
                this.log("error", `error of some connection on URL ${this.params.listen}: ${error.message}`)
            })
            const type = this.params.type
            const mode = this.params.mode
            this.stream = new Stream.Duplex({
                writableObjectMode: true,
                readableObjectMode: true,
                decodeStrings:      false,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (mode === "r")
                        callback(new Error("write operation on read-only node"))
                    else if (chunk.type !== type)
                        callback(new Error(`written chunk is not of ${type} type`))
                    else if (websockets.size === 0)
                        callback(new Error("still no Websocket connections available"))
                    else {
                        const data = utils.streamChunkEncode(chunk)
                        const results = []
                        for (const websocket of websockets.values()) {
                            results.push(new Promise<void>((resolve, reject) => {
                                websocket.send(data, (error) => {
                                    if (error)
                                        reject(error)
                                    else
                                        resolve()
                                })
                            }))
                        }
                        Promise.all(results).then(() => {
                            callback()
                        }).catch((errors: Error[]) => {
                            const error = new Error(errors.map((e) => e.message).join("; "))
                            callback(error)
                        })
                    }
                },
                read (size: number) {
                    if (mode === "w")
                        throw new Error("read operation on write-only node")
                    chunkQueue.read().then((chunk) => {
                        this.push(chunk, "binary")
                    })
                }
            })
        }
        else if (this.params.connect !== "") {
            /*  connect remotely to a Websocket port  */
            this.client = new ReconnWebSocket(this.params.connect, [], {
                WebSocket:                   ws,
                WebSocketOptions:            {},
                reconnectionDelayGrowFactor: 1.3,
                maxReconnectionDelay:        4000,
                minReconnectionDelay:        1000,
                connectionTimeout:           4000,
                minUptime:                   5000
            })
            this.client.addEventListener("open", (ev) => {
                this.log("info", `connection opened to URL ${this.params.connect}`)
            })
            this.client.addEventListener("close", (ev) => {
                this.log("info", `connection closed to URL ${this.params.connect}`)
            })
            this.client.addEventListener("error", (ev: ErrorEvent) => {
                this.log("error", `error of connection on URL ${this.params.connect}: ${ev.error.message}`)
            })
            const chunkQueue = new utils.SingleQueue<SpeechFlowChunk>()
            this.client.addEventListener("message", (ev: MessageEvent) => {
                if (this.params.mode === "w") {
                    this.log("warning", `connection to URL ${this.params.listen}: ` +
                        "received remote data on write-only node")
                    return
                }
                if (!(ev.data instanceof ArrayBuffer)) {
                    this.log("warning", `connection to URL ${this.params.listen}: ` +
                        "received non-binary message")
                    return
                }
                const buffer = Buffer.from(ev.data)
                const chunk = utils.streamChunkDecode(buffer)
                chunkQueue.write(chunk)
            })
            const client = this.client
            client.binaryType = "arraybuffer"
            const type = this.params.type
            const mode = this.params.mode
            this.stream = new Stream.Duplex({
                writableObjectMode: true,
                readableObjectMode: true,
                decodeStrings:      false,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (mode === "r")
                        callback(new Error("write operation on read-only node"))
                    else if (chunk.type !== type)
                        callback(new Error(`written chunk is not of ${type} type`))
                    else if (!client.OPEN)
                        callback(new Error("still no Websocket connection available"))
                    const data = utils.streamChunkEncode(chunk)
                    client.send(data)
                    callback()
                },
                read (size: number) {
                    if (mode === "w")
                        throw new Error("read operation on write-only node")
                    if (!client.OPEN)
                        throw new Error("still no Websocket connection available")
                    chunkQueue.read().then((chunk) => {
                        this.push(chunk, "binary")
                    })
                }
            })
        }
    }

    /*  close node  */
    async close () {
        /*  close Websocket server  */
        if (this.server !== null) {
            await new Promise<void>((resolve, reject) => {
                this.server!.close((error) => {
                    if (error) reject(error)
                    else       resolve()
                })
            })
            this.server = null
        }

        /*  close Websocket client  */
        if (this.client !== null) {
            this.client!.close()
            this.client = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}

