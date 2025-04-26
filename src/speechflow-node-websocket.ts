/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Stream           from "node:stream"
import ws               from "ws"
import ReconnWebsocket, { ErrorEvent }  from "@opensumi/reconnecting-websocket"
import SpeechFlowNode   from "./speechflow-node"

export default class SpeechFlowNodeWebsocket extends SpeechFlowNode {
    private server: ws.WebSocketServer | null = null
    private client: WebSocket | null = null
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)
        this.configure({
            listen:  { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+))$/ },
            connect: { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/ },
            type:    { type: "string", val: "text", match: /^(?:audio|text)$/ }
        })
    }
    async open () {
        this.input  = this.params.type
        this.output = this.params.type
        if (this.params.listen !== "") {
            const url = new URL(this.params.listen)
            let websocket: ws.WebSocket | null = null
            const server = new ws.WebSocketServer({
                host: url.hostname,
                port: Number.parseInt(url.port),
                path: url.pathname
            })
            server.on("listening", () => {
                this.log("info", `listening on URL ${this.params.listen}`)
            })
            server.on("connection", (ws, request) => {
                this.log("info", `connection opened on URL ${this.params.listen}`)
                websocket = ws
            })
            server.on("close", () => {
                this.log("info", `connection closed on URL ${this.params.listen}`)
                websocket = null
            })
            server.on("error", (error) => {
                this.log("error", `error on URL ${this.params.listen}: ${error.message}`)
                websocket = null
            })
            this.stream = new Stream.Duplex({
                write (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void) {
                    const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                    if (websocket !== null) {
                        websocket.send(data, (error) => {
                            if (error) callback(error)
                            else       callback()
                        })
                    }
                    else
                        callback(new Error("still no Websocket connection available"))
                },
                read (size: number) {
                    if (websocket !== null) {
                        websocket.once("message", (data, isBinary) => {
                            this.push(data, isBinary ? "binary" : "utf8")
                        })
                    }
                    else
                        throw new Error("still no Websocket connection available")
                }
            })
        }
        else if (this.params.connect !== "") {
            this.client = new ReconnWebsocket(this.params.connect, [], {
                WebSocket:                   ws,
                WebSocketOptions:            {},
                reconnectionDelayGrowFactor: 1.3,
                maxReconnectionDelay:        4000,
                minReconnectionDelay:        1000,
                connectionTimeout:           4000,
                minUptime:                   5000
            })
            this.client.addEventListener("open", (ev: Event) => {
                this.log("info", `connection opened on URL ${this.params.connect}`)
            })
            this.client.addEventListener("close", (ev: Event) => {
                this.log("info", `connection closed on URL ${this.params.connect}`)
            })
            this.client.addEventListener("error", (ev: ErrorEvent) => {
                this.log("error", `error on URL ${this.params.connect}: ${ev.error.message}`)
            })
            const client = this.client
            client.binaryType = "arraybuffer"
            this.stream = new Stream.Duplex({
                write (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void) {
                    const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                    if (client.OPEN) {
                        client.send(data)
                        callback()
                    }
                    else
                        callback(new Error("still no Websocket connection available"))
                },
                read (size: number) {
                    if (client.OPEN) {
                        client.addEventListener("message", (ev: MessageEvent) => {
                            if (ev.data instanceof ArrayBuffer)
                                this.push(ev.data, "binary")
                            else
                                this.push(ev.data, "utf8")
                        }, { once: true })
                    }
                    else
                        throw new Error("still no Websocket connection available")
                }
            })
        }
        else
            throw new Error("neither listen nor connect mode requested")
    }
    async close () {
        if (this.server !== null) {
            await new Promise<void>((resolve, reject) => {
                this.server!.close((error) => {
                    if (error) reject(error)
                    else       resolve()
                })
            })
            this.server = null
        }
        if (this.client !== null) {
            this.client!.close()
            this.client = null
        }
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}

