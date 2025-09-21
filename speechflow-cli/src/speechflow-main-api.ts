/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path               from "node:path"
import http               from "node:http"

/*  external dependencies  */
import * as HAPI          from "@hapi/hapi"
import Inert              from "@hapi/inert"
import WebSocket          from "ws"
import HAPIWebSocket      from "hapi-plugin-websocket"
import HAPIHeader         from "hapi-plugin-header"
import OSC                from "osc-js"
import * as arktype       from "arktype"
import CLIio              from "cli-io"

/*  internal dependencies  */
import * as util          from "./speechflow-util"
import { CLIOptions }     from "./speechflow-main-cli"
import { NodeGraph }      from "./speechflow-main-graph"
import pkg                from "../../package.json"

/*  internal helper type definitions  */
type WSPeerInfo = {
    ctx:  Record<string, any>
    ws:   WebSocket
    req:  http.IncomingMessage
}

/*  Application Programming Interface (API) server management class  */
export class APIServer {
    /*  internal state  */
    private wsPeers  = new Map<string, WSPeerInfo>()
    private hapi:    HAPI.Server | null = null
    private sendOSC: ((url: string, ...args: any[]) => void) | null = null

    /*  creation  */
    constructor (
        private cli: CLIio
    ) {}

    /*  start API server service  */
    async start(args: CLIOptions, graph: NodeGraph): Promise<void> {
        /*  define external request/response structure  */
        const requestValidator = arktype.type({
            request: "string",
            node:    "string",
            args:    "unknown[]"
        })

        /*  forward external request to target node in graph  */
        const consumeExternalRequest = async (_req: unknown) => {
            const req = requestValidator(_req)
            if (req instanceof arktype.type.errors)
                throw new Error(`invalid request: ${req.summary}`)
            if (req.request !== "COMMAND")
                throw new Error("invalid external request (command expected)")
            const name = req.node as string
            const argList = req.args as any[]
            const foundNode = graph.findGraphNode(name)
            if (foundNode === undefined) {
                this.cli.log("warning", `external request failed: no such node <${name}>`)
                throw new Error(`external request failed: no such node <${name}>`)
            }
            else {
                await Promise.race<void>([
                    foundNode.receiveRequest(argList),
                    new Promise<never>((resolve, reject) => setTimeout(() =>
                        reject(new Error("timeout")), 10 * 1000))
                ]).catch((err: Error) => {
                    this.cli.log("warning", `external request to node <${name}> failed: ${err.message}`)
                    throw err
                })
            }
        }

        /*  establish REST/WebSocket API  */
        this.hapi = new HAPI.Server({
            address: args.a,
            port:    args.p
        })
        await this.hapi.register({ plugin: Inert })
        await this.hapi.register({ plugin: HAPIHeader, options: { Server: `${pkg.name}/${pkg.version}` } })
        await this.hapi.register({ plugin: HAPIWebSocket })
        this.hapi.events.on("response", (request: HAPI.Request) => {
            let protocol = `HTTP/${request.raw.req.httpVersion}`
            const ws = request.websocket()
            if (ws.mode === "websocket") {
                const wsVersion = (ws.ws as any).protocolVersion ??
                    request.headers["sec-websocket-version"] ?? "13?"
                protocol = `WebSocket/${wsVersion}+${protocol}`
            }
            const msg =
                "remote="   + request.info.remoteAddress + ", " +
                "method="   + request.method.toUpperCase() + ", " +
                "url="      + request.url.pathname + ", " +
                "protocol=" + protocol + ", " +
                "response=" + ("statusCode" in request.response ? request.response.statusCode : "<unknown>")
            this.cli.log("info", `HAPI: request: ${msg}`)
        })
        this.hapi.events.on({ name: "request", channels: [ "error" ] }, (request: HAPI.Request, event: HAPI.RequestEvent, tags: { [key: string]: true }) => {
            if (event.error instanceof Error)
                this.cli.log("error", `HAPI: request-error: ${event.error.message}`)
            else
                this.cli.log("error", `HAPI: request-error: ${event.error}`)
        })
        this.hapi.events.on("log", (event: HAPI.LogEvent, tags: { [key: string]: true }) => {
            if (tags.error) {
                const err = event.error
                if (err instanceof Error)
                    this.cli.log("error", `HAPI: log: ${err.message}`)
                else
                    this.cli.log("error", `HAPI: log: ${err}`)
            }
        })

        /*  define REST/WebSocket API endpoints  */
        this.hapi.route({
            method: "GET",
            path: "/{param*}",
            handler: {
                directory: {
                    path: path.join(__dirname, "../../speechflow-ui-db/dst"),
                    redirectToSlash: true,
                    index: true
                }
            }
        })
        this.hapi.route({
            method: "GET",
            path:   "/api/dashboard",
            handler: (request: HAPI.Request, h: HAPI.ResponseToolkit) => {
                const config = []
                for (const block of args.d.split(",")) {
                    const [ type, id, name ] = block.split(":")
                    config.push({ type, id, name })
                }
                return h.response(config).code(200)
            }
        })
        this.hapi.route({
            method: "GET",
            path:   "/api/{req}/{node}/{params*}",
            options: {},
            handler: (request: HAPI.Request, h: HAPI.ResponseToolkit) => {
                const peer = request.info.remoteAddress
                const params = request.params.params as string ?? ""
                if (params.length > 1000)
                    return h.response({ response: "ERROR", data: "parameters too long" }).code(400)
                const req = {
                    request: request.params.req,
                    node:    request.params.node,
                    args:    params.split("/").filter((seg) => seg !== "")
                }
                this.cli.log("info", `HAPI: peer ${peer}: GET: ${JSON.stringify(req)}`)
                return consumeExternalRequest(req)
                    .then(()     => h.response({ response: "OK" }).code(200))
                    .catch((error: unknown) => h.response({ response: "ERROR", data: util.ensureError(error).message }).code(417))
            }
        })
        this.hapi.route({
            method: "POST",
            path:   "/api",
            options: {
                payload: {
                    output:   "data",
                    parse:    true,
                    allow:    "application/json",
                    maxBytes: 1 * 1024 * 1024
                },
                plugins: {
                    websocket: {
                        autoping: 30 * 1000,
                        connect: ({ ctx, ws, req }) => {
                            const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
                            ctx.peer = peer
                            this.wsPeers.set(peer, { ctx, ws, req })
                            this.cli.log("info", `HAPI: WebSocket: connect: peer ${peer}`)
                        },
                        disconnect: ({ ctx, ws }) => {
                            const peer = ctx.peer
                            this.wsPeers.delete(peer)
                            ws.removeAllListeners()
                            if (ws.readyState === WebSocket.OPEN)
                                ws.close()
                            this.cli.log("info", `HAPI: WebSocket: disconnect: peer ${peer}`)
                        }
                    }
                }
            },
            handler: (request: HAPI.Request, h: HAPI.ResponseToolkit) => {
                /*  on WebSocket message transfer  */
                const peer = request.info.remoteAddress
                const req = requestValidator(request.payload)
                if (req instanceof arktype.type.errors)
                    return h.response({ response: "ERROR", data: `invalid request: ${req.summary}` }).code(417)
                this.cli.log("info", `HAPI: peer ${peer}: POST: ${JSON.stringify(req)}`)
                return consumeExternalRequest(req)
                    .then(()            => h.response({ response: "OK" }).code(200))
                    .catch((err: Error) => h.response({ response: "ERROR", data: err.message }).code(417))
            }
        })

        /*  start up REST/WebSockets service  */
        await this.hapi.start()
        this.cli.log("info", `HAPI: started REST/WebSocket network service: http://${args.a}:${args.p}`)

        /*  hook for sendResponse method of nodes  */
        for (const node of graph.getGraphNodes()) {
            node.on("send-response", (argList: any[]) => {
                const data = JSON.stringify({ response: "NOTIFY", node: node.id, args: argList })
                for (const [ peer, info ] of this.wsPeers.entries()) {
                    this.cli.log("debug", `HAPI: remote peer ${peer}: sending ${data}`)
                    if (info.ws.readyState === WebSocket.OPEN)
                        info.ws.send(data)
                }
            })
        }

        /*  establish Open State Control (OSC) event emission  */
        if (args.o !== "") {
            const osc = new OSC({ plugin: new OSC.DatagramPlugin({ type: "udp4" }) })
            const m = args.o.match(/^(.+?):(\d+)$/)
            if (m === null)
                throw new Error("invalid OSC/UDP endpoint (expected <ip-adress>:<udp-port>)")
            const host = m[1]
            const port = m[2]
            this.sendOSC = (url: string, ...argList: any[]) => {
                const msg = new OSC.Message(url, ...argList)
                osc.send(msg, { host, port })
            }
        }

        /*  hook for send-dashboard method of nodes  */
        for (const node of graph.getGraphNodes()) {
            node.on("send-dashboard", (info: {
                type: "audio" | "text",
                id:   string,
                kind: "final" | "intermediate",
                value: string | number
            }) => {
                const data = JSON.stringify({
                    response: "DASHBOARD",
                    node:     "",
                    args:     [ info.type, info.id, info.kind, info.value ]
                })
                for (const [ peer, info ] of this.wsPeers.entries()) {
                    this.cli.log("debug", `HAPI: dashboard peer ${peer}: send ${data}`)
                    info.ws.send(data)
                }
                for (const n of graph.getGraphNodes()) {
                    Promise.race<void>([
                        n.receiveDashboard(info.type, info.id, info.kind, info.value),
                        new Promise<never>((resolve, reject) => setTimeout(() =>
                            reject(new Error("timeout")), 10 * 1000))
                    ]).catch((err: Error) => {
                        this.cli.log("warning", `sending dashboard info to node <${n.id}> failed: ${err.message}`)
                    })
                }
                if (args.o !== "" && this.sendOSC)
                    this.sendOSC("/speechflow/dashboard", info.type, info.id, info.kind, info.value)
            })
        }
    }

    /*  stop API server service  */
    async stop(args: CLIOptions): Promise<void> {
        /*  shutdown HAPI service  */
        if (this.hapi) {
            this.cli.log("info", `HAPI: stopping REST/WebSocket network service: http://${args.a}:${args.p}`)
            await this.hapi.stop({ timeout: 2000 })
        }

        /*  clear WebSocket connections  */
        if (this.wsPeers.size > 0) {
            this.cli.log("info", "HAPI: closing WebSocket connections")
            const closePromises: Promise<void>[] = []
            for (const [ peer, info ] of this.wsPeers.entries()) {
                closePromises.push(new Promise<void>((resolve, reject) => {
                    if (info.ws.readyState !== WebSocket.OPEN)
                        resolve()
                    else {
                        const timeout = setTimeout(() => {
                            reject(new Error(`timeout for peer ${peer}`))
                        }, 2 * 1000)
                        info.ws.once("close", () => {
                            clearTimeout(timeout)
                            resolve()
                        })
                        info.ws.close()
                    }
                }))
            }
            await Promise.race([
                Promise.all(closePromises),
                new Promise((resolve, reject) =>
                    setTimeout(() => reject(new Error("timeout for all peers")), 5 * 1000))
            ]).catch((error: unknown) => {
                this.cli.log("warning", `HAPI: WebSockets failed to close: ${util.ensureError(error).message}`)
            })
            this.wsPeers.clear()
        }
    }
}
