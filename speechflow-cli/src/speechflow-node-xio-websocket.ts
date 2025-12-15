/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import ws                              from "ws"
import ReconnWebSocket, { ErrorEvent } from "@opensumi/reconnecting-websocket"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for WebSocket networking  */
export default class SpeechFlowNodeXIOWebSocket extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-websocket"

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

        /*  sanity check parameters  */
        if (this.params.listen !== "" && this.params.connect !== "")
            throw new Error("WebSocket node cannot listen and connect at the same time")
        else if (this.params.listen === "" && this.params.connect === "")
            throw new Error("WebSocket node requires either listen or connect mode")

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
        if (this.params.listen !== "") {
            /*  listen locally on a Websocket port  */
            const url = new URL(this.params.listen)
            const websockets = new Set<ws.WebSocket>()
            const chunkQueue = new util.SingleQueue<SpeechFlowChunk>()
            this.server = new ws.WebSocketServer({
                host: url.hostname,
                port: Number.parseInt(url.port, 10),
                path: url.pathname
            })
            this.server.on("listening", () => {
                this.log("info", `listening on URL ${this.params.listen}`)
            })
            this.server.on("connection", (ws, request) => {
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
                    const chunk = util.streamChunkDecode(buffer)
                    chunkQueue.write(chunk)
                })
            })
            this.server.on("error", (error) => {
                this.log("error", `error of some connection on URL ${this.params.listen}: ${error.message}`)
            })
            const self = this
            const reads = new util.PromiseSet<void>()
            this.stream = new Stream.Duplex({
                writableObjectMode: true,
                readableObjectMode: true,
                decodeStrings:      false,
                highWaterMark:      1,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (self.params.mode === "r")
                        callback(new Error("write operation on read-only node"))
                    else if (chunk.type !== self.params.type)
                        callback(new Error(`written chunk is not of ${self.params.type} type`))
                    else if (websockets.size === 0)
                        callback(new Error("still no WebSocket connections available"))
                    else {
                        const data = util.streamChunkEncode(chunk)
                        const results: Promise<void>[] = []
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
                        }).catch((error: unknown) => {
                            callback(util.ensureError(error))
                        })
                    }
                },
                async final (callback) {
                    await reads.awaitAll()
                    callback()
                },
                read (size: number) {
                    if (self.params.mode === "w")
                        throw new Error("read operation on write-only node")
                    reads.add(chunkQueue.read().then((chunk) => {
                        this.push(chunk, "binary")
                    }).catch((err: Error) => {
                        self.log("warning", `read on chunk queue operation failed: ${err}`)
                    }))
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
            this.client.addEventListener("open", (_ev) => {
                this.log("info", `connection opened to URL ${this.params.connect}`)
            })
            this.client.addEventListener("close", (_ev) => {
                this.log("info", `connection closed to URL ${this.params.connect}`)
            })
            this.client.addEventListener("error", (ev: ErrorEvent) => {
                const error = util.ensureError(ev.error)
                this.log("error", `error of connection on URL ${this.params.connect}: ${error.message}`)
            })
            const chunkQueue = new util.SingleQueue<SpeechFlowChunk>()
            this.client.addEventListener("message", (ev: MessageEvent) => {
                if (this.params.mode === "w") {
                    this.log("warning", `connection to URL ${this.params.connect}: ` +
                        "received remote data on write-only node")
                    return
                }
                if (!(ev.data instanceof ArrayBuffer)) {
                    this.log("warning", `connection to URL ${this.params.connect}: ` +
                        "received non-binary message")
                    return
                }
                const buffer = Buffer.from(ev.data)
                const chunk = util.streamChunkDecode(buffer)
                chunkQueue.write(chunk)
            })
            this.client.binaryType = "arraybuffer"
            const self = this
            const reads = new util.PromiseSet<void>()
            this.stream = new Stream.Duplex({
                writableObjectMode: true,
                readableObjectMode: true,
                decodeStrings:      false,
                highWaterMark:      1,
                write (chunk: SpeechFlowChunk, encoding, callback) {
                    if (self.params.mode === "r")
                        callback(new Error("write operation on read-only node"))
                    else if (chunk.type !== self.params.type)
                        callback(new Error(`written chunk is not of ${self.params.type} type`))
                    else if (!self.client!.OPEN)
                        callback(new Error("still no WebSocket connection available"))
                    else {
                        const data = util.streamChunkEncode(chunk)
                        self.client!.send(data)
                        callback()
                    }
                },
                async final (callback) {
                    await reads.awaitAll()
                    callback()
                },
                read (size: number) {
                    if (self.params.mode === "w")
                        throw new Error("read operation on write-only node")
                    reads.add(chunkQueue.read().then((chunk) => {
                        this.push(chunk, "binary")
                    }).catch((err: Error) => {
                        self.log("warning", `read on chunk queue operation failed: ${err}`)
                    }))
                }
            })
        }
    }

    /*  close node  */
    async close () {
        /*  close WebSocket server  */
        if (this.server !== null) {
            await new Promise<void>((resolve, reject) => {
                this.server!.close((error) => {
                    if (error) reject(error)
                    else       resolve()
                })
            })
            this.server = null
        }

        /*  close WebSocket client  */
        if (this.client !== null) {
            this.client.close()
            this.client = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

