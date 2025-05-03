/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                          from "node:stream"

/*  external dependencies  */
import ws                              from "ws"
import ReconnWebsocket, { ErrorEvent } from "@opensumi/reconnecting-websocket"

/*  internal dependencies  */
import SpeechFlowNode                  from "./speechflow-node"

/*  SpeechFlow node for Websocket networking  */
export default class SpeechFlowNodeWebsocket extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "websocket"

    /*  internal state  */
    private server: ws.WebSocketServer | null = null
    private client: WebSocket          | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            listen:  { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+))$/ },
            connect: { type: "string", val: "",     match: /^(?:|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/ },
            type:    { type: "string", val: "text", match: /^(?:audio|text)$/ }
        })

        /*  sanity check usage  */
        if (this.params.listen !== "" && this.params.connect !== "")
            throw new Error("Websocket node cannot listen and connect at the same time")
        else if (this.params.listen === "" && this.params.connect === "")
            throw new Error("Websocket node requires either listen or connect mode")

        /*  declare node input/output format  */
        if (this.params.listen !== "") {
            this.input  = "none"
            this.output = this.params.type
        }
        else if (this.params.connect !== "") {
            this.input  = this.params.type
            this.output = "none"
        }
    }

    /*  open node  */
    async open () {
        if (this.params.listen !== "") {
            /*  listen locally on a Websocket port  */
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
            const textEncoding = this.config.textEncoding
            const type = this.params.type
            this.stream = new Stream.Duplex({
                writableObjectMode: false,
                readableObjectMode: false,
                decodeStrings:      false,
                write (chunk: Buffer | string, encoding, callback) {
                    if (type === "audio" && !Buffer.isBuffer(chunk))
                        chunk = Buffer.from(chunk)
                    else if (type === "text" && Buffer.isBuffer(chunk))
                        chunk = chunk.toString(encoding ?? textEncoding)
                    if (websocket !== null) {
                        websocket.send(chunk, (error) => {
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
                            this.push(data, isBinary ? "binary" : textEncoding)
                        })
                    }
                    else
                        throw new Error("still no Websocket connection available")
                }
            })
        }
        else if (this.params.connect !== "") {
            /*  connect remotely to a Websocket port  */
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
            const textEncoding = this.config.textEncoding
            const type = this.params.type
            this.stream = new Stream.Duplex({
                writableObjectMode: false,
                readableObjectMode: false,
                decodeStrings:      false,
                write (chunk: Buffer | string, encoding, callback) {
                    if (type === "audio" && !Buffer.isBuffer(chunk))
                        chunk = Buffer.from(chunk)
                    else if (type === "text" && Buffer.isBuffer(chunk))
                        chunk = chunk.toString(encoding ?? textEncoding)
                    if (client.OPEN) {
                        client.send(chunk)
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
                                this.push(ev.data, textEncoding)
                        }, { once: true })
                    }
                    else
                        throw new Error("still no Websocket connection available")
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

