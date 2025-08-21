#!/usr/bin/env node
/*!
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path              from "node:path"
import Stream            from "node:stream"
import { EventEmitter }  from "node:events"
import http              from "node:http"
import * as HAPI         from "@hapi/hapi"
import Inert             from "@hapi/inert"
import WebSocket         from "ws"
import HAPIWebSocket     from "hapi-plugin-websocket"
import HAPIHeader        from "hapi-plugin-header"

/*  external dependencies  */
import { DateTime }      from "luxon"
import CLIio             from "cli-io"
import yargs             from "yargs"
import { hideBin }       from "yargs/helpers"
import jsYAML            from "js-yaml"
import FlowLink          from "flowlink"
import objectPath        from "object-path"
import installedPackages from "installed-packages"
import dotenvx           from "@dotenvx/dotenvx"
import syspath           from "syspath"
import * as arktype      from "arktype"
import Table             from "cli-table3"
import chalk             from "chalk"

/*  internal dependencies  */
import SpeechFlowNode    from "./speechflow-node"
import pkg               from "../../package.json"

/*  central CLI context  */
let cli: CLIio | null = null

type wsPeerCtx = {
    peer: string
}
type wsPeerInfo = {
    ctx:        wsPeerCtx
    ws:         WebSocket
    req:        http.IncomingMessage
}

/*  establish asynchronous environment  */
let debug = false
;(async () => {
    /*  determine system paths  */
    const { dataDir } = syspath({
        appName: "speechflow",
        dataDirAutoCreate: true
    })

    /*  parse command-line arguments  */
    const coerce = (arg: string) => Array.isArray(arg) ? arg[arg.length - 1] : arg
    const args = await yargs()
        /* eslint @stylistic/indent: off */
        .usage(
            "Usage: $0 " +
            "[-h|--help] " +
            "[-V|--version] " +
            "[-S|--status] " +
            "[-v|--verbose <level>] " +
            "[-a|--address <ip-address>] " +
            "[-p|--port <tcp-port>] " +
            "[-C|--cache <directory>] " +
            "[-d|--dashboard <type>:<id>:<name>[,...]] " +
            "[-e|--expression <expression>] " +
            "[-f|--file <file>] " +
            "[-c|--config <id>@<yaml-config-file>] " +
            "[<argument> [...]]"
        )
        .version(false)
        .option("V", {
            alias:    "version",
            type:     "boolean",
            array:    false,
            coerce,
            default:  false,
            describe: "show program version information"
        })
        .option("S", {
            alias:    "status",
            type:     "boolean",
            array:    false,
            coerce,
            default:  false,
            describe: "show one-time status of nodes"
        })
        .option("v", {
            alias:    "log-level",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "warning",
            describe: "level for verbose logging ('none', 'error', 'warning', 'info', 'debug')"
        })
        .option("a", {
            alias:    "address",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "0.0.0.0",
            describe: "IP address for REST/WebSocket API"
        })
        .option("p", {
            alias:    "port",
            type:     "number",
            array:    false,
            coerce,
            nargs:    1,
            default:  8484,
            describe: "TCP port for REST/WebSocket API"
        })
        .option("C", {
            alias:    "cache",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  path.join(dataDir, "cache"),
            describe: "directory for cached files (primarily AI model files)"
        })
        .option("d", {
            alias:    "dashboard",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "",
            describe: "list of dashboard block types and names"
        })
        .option("e", {
            alias:    "expression",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "",
            describe: "FlowLink expression string"
        })
        .option("f", {
            alias:    "file",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "",
            describe: "FlowLink expression file"
        })
        .option("c", {
            alias:    "config",
            type:     "string",
            array:    false,
            coerce,
            nargs:    1,
            default:  "",
            describe: "FlowLink expression reference into YAML file (in format <id>@<file>)"
        })
        .help("h", "show usage help")
        .alias("h", "help")
        .showHelpOnFail(true)
        .strict()
        .demand(0)
        .parse(hideBin(process.argv))

    /*  short-circuit version request  */
    if (args.V) {
        process.stderr.write(`SpeechFlow ${pkg["x-stdver"]} (${pkg["x-release"]}) <${pkg.homepage}>\n`)
        process.stderr.write(`${pkg.description}\n`)
        process.stderr.write(`Copyright (c) 2024-2025 ${pkg.author.name} <${pkg.author.url}>\n`)
        process.stderr.write(`Licensed under ${pkg.license} <http://spdx.org/licenses/${pkg.license}.html>\n`)
        process.exit(0)
    }

    /*  establish CLI environment  */
    cli = new CLIio({
        encoding:  "utf8",
        logLevel:  args.v,
        logTime:   true,
        logPrefix: pkg.name
    })
    if (args.v.match(/^(?:info|debug)$/))
        debug = true

    /*  catch uncaught exceptions  */
    process.on("uncaughtException", (err) => {
        if (debug)
            cli!.log("error", `uncaught exception: ${err.message}\n${err.stack}`)
        else
            cli!.log("error", `uncaught exception: ${err.message}`)
        process.exit(1)
    })

    /*  catch unhandled promise rejections  */
    process.on("unhandledRejection", (reason) => {
        if (reason instanceof Error) {
            if (debug)
                cli!.log("error", `unhandled rejection: ${reason.message}\n${reason.stack}`)
            else
                cli!.log("error", `unhandled rejection: ${reason.message}`)
        }
        else
            cli!.log("error", `unhandled rejection: ${reason}`)
        process.exit(1)
    })

    /*  provide startup information  */
    cli.log("info", `starting SpeechFlow ${pkg["x-stdver"]} (${pkg["x-release"]})`)

    /*  load .env files  */
    const result = dotenvx.config({
        encoding: "utf8",
        ignore:   [ "MISSING_ENV_FILE" ],
        quiet:    true
    })
    if (result?.parsed !== undefined)
        for (const key of Object.keys(result.parsed))
            cli.log("info", `loaded environment variable "${key}" from ".env" files`)

    /*  sanity check usage  */
    let n = 0
    if (typeof args.e === "string" && args.e !== "") n++
    if (typeof args.f === "string" && args.f !== "") n++
    if (typeof args.c === "string" && args.c !== "") n++
    if (n === 0)
        throw new Error("need at least one FlowLink specification source (use one of the options -e, -f or -c)")
    else if (n !== 1)
        throw new Error("cannot use more than one FlowLink specification source (use only one of the options -e, -f or -c)")

    /*  read configuration  */
    let config = ""
    if (typeof args.e === "string" && args.e !== "")
        config = args.e
    else if (typeof args.f === "string" && args.f !== "")
        config = await cli.input(args.f, { encoding: "utf8" })
    else if (typeof args.c === "string" && args.c !== "") {
        const m = args.c.match(/^(.+?)@(.+)$/)
        if (m === null)
            throw new Error("invalid configuration file specification (expected \"<id>@<yaml-config-file>\")")
        const [ , id, file ] = m
        const yaml = await cli.input(file, { encoding: "utf8" })
        let obj: any
        try {
            obj = jsYAML.load(yaml)
        }
        catch (err) {
            if (err instanceof Error)
                throw new Error(`failed to parse YAML configuration: ${err.message}`)
            else
                throw new Error(`failed to parse YAML configuration: ${err}`)
        }
        if (obj[id] === undefined)
            throw new Error(`no such id "${id}" found in configuration file "${file}"`)
        config = obj[id] as string
    }

    /*  track the available SpeechFlow nodes  */
    const nodes: { [ id: string ]: typeof SpeechFlowNode } = {}

    /*  load internal SpeechFlow nodes  */
    const pkgsI = [
        "./speechflow-node-a2a-compressor.js",
        "./speechflow-node-a2a-expander.js",
        "./speechflow-node-a2a-ffmpeg.js",
        "./speechflow-node-a2a-gender.js",
        "./speechflow-node-a2a-meter.js",
        "./speechflow-node-a2a-mute.js",
        "./speechflow-node-a2a-rnnoise.js",
        "./speechflow-node-a2a-speex.js",
        "./speechflow-node-a2a-vad.js",
        "./speechflow-node-a2a-wav.js",
        "./speechflow-node-a2t-awstranscribe.js",
        "./speechflow-node-a2t-openaitranscribe.js",
        "./speechflow-node-a2t-deepgram.js",
        "./speechflow-node-t2a-awspolly.js",
        "./speechflow-node-t2a-elevenlabs.js",
        "./speechflow-node-t2a-kokoro.js",
        "./speechflow-node-t2t-awstranslate.js",
        "./speechflow-node-t2t-deepl.js",
        "./speechflow-node-t2t-format.js",
        "./speechflow-node-t2t-ollama.js",
        "./speechflow-node-t2t-openai.js",
        "./speechflow-node-t2t-sentence.js",
        "./speechflow-node-t2t-subtitle.js",
        "./speechflow-node-t2t-transformers.js",
        "./speechflow-node-x2x-filter.js",
        "./speechflow-node-x2x-trace.js",
        "./speechflow-node-xio-device.js",
        "./speechflow-node-xio-file.js",
        "./speechflow-node-xio-mqtt.js",
        "./speechflow-node-xio-websocket.js"
    ]
    for (const pkg of pkgsI) {
        let node: any = await import(pkg)
        while (node.default !== undefined)
            node = node.default
        if (typeof node === "function" && typeof node.name === "string") {
            cli.log("info", `loading SpeechFlow node <${node.name}> from internal module`)
            nodes[node.name] = node as typeof SpeechFlowNode
        }
    }

    /*  load external SpeechFlow nodes  */
    const pkgsE = await installedPackages()
    for (const pkg of pkgsE) {
        if (pkg.match(/^(?:@[^/]+\/)?speechflow-node-.+$/)) {
            let node: any = await import(pkg)
            while (node.default !== undefined)
                node = node.default
            if (typeof node === "function" && typeof node.name === "string") {
                if (nodes[node.name] !== undefined) {
                    cli.log("warning", `failed loading SpeechFlow node <${node.name}> ` +
                        `from external module "${pkg}" -- node already exists`)
                    continue
                }
                cli.log("info", `loading SpeechFlow node <${node.name}> from external module "${pkg}"`)
                nodes[node.name] = node as typeof SpeechFlowNode
            }
        }
    }

    /*  static configuration  */
    const cfg = {
        audioChannels:     1,
        audioBitDepth:     16,
        audioLittleEndian: true,
        audioSampleRate:   48000,
        textEncoding:      "utf8",
        cacheDir:          args.C
    }

    /*  provide access to internal communication busses  */
    const busses = new Map<string, EventEmitter>()
    const accessBus = (name: string): EventEmitter => {
        let bus: EventEmitter
        if (busses.has(name))
            bus = busses.get(name)!
        else {
            bus = new EventEmitter()
            busses.set(name, bus)
        }
        return bus
    }

    /*  handle one-time status query of nodes  */
    if (args.S) {
        const table = new Table({
            head: [
                chalk.reset.bold("NODE"),
                chalk.reset.bold("PROPERTY"),
                chalk.reset.bold("VALUE")
            ],
            colWidths: [ 15, 15, 50 - (2 * 2 + 2 * 3) ],
            style: { "padding-left": 1, "padding-right": 1, border: [ "grey" ], compact: true },
            chars: { "left-mid": "", mid: "", "mid-mid": "", "right-mid": "" }
        })
        for (const name of Object.keys(nodes)) {
            cli!.log("info", `gathering status of node <${name}>`)
            const node = new nodes[name](name, cfg, {}, [])
            node._accessBus = accessBus
            const status = await Promise.race<{ [ key: string ]: string | number }>([
                node.status(),
                new Promise<never>((resolve, reject) => setTimeout(() =>
                    reject(new Error("timeout")), 10 * 1000))
            ]).catch((err: Error) => {
                cli!.log("warning", `[${node.id}]: failed to gather status of node <${node.id}>: ${err.message}`)
                return {} as { [ key: string ]: string | number }
            })
            if (Object.keys(status).length > 0) {
                let first = true
                for (const key of Object.keys(status)) {
                    table.push([ first ? chalk.bold(name) : "", key, chalk.blue(status[key]) ])
                    first = false
                }
            }
        }
        const output = table.toString()
        process.stdout.write(output + "\n")
        process.exit(0)
    }

    /*  graph processing: PASS 1: parse DSL and create and connect nodes  */
    const flowlink = new FlowLink<SpeechFlowNode>({
        trace: (msg: string) => {
            cli!.log("debug", msg)
        }
    })
    const variables = { argv: args._, env: process.env }
    const graphNodes = new Set<SpeechFlowNode>()
    const nodeNums = new Map<typeof SpeechFlowNode, number>()
    let ast: unknown
    try {
        ast = flowlink.compile(config)
    }
    catch (err) {
        const errorMsg = err instanceof Error && err.name === "FlowLinkError"
            ? err.toString() : (err instanceof Error ? err.message : "internal error")
        cli!.log("error", `failed to parse SpeechFlow configuration: ${errorMsg}`)
        process.exit(1)
    }
    try {
        flowlink.execute(ast, {
            resolveVariable (id: string) {
                if (!objectPath.has(variables, id))
                    throw new Error(`failed to resolve variable "${id}"`)
                const value = objectPath.get(variables, id)
                cli!.log("info", `resolve variable: "${id}" -> "${value}"`)
                return value
            },
            createNode (id: string, opts: { [ id: string ]: any }, args: any[]) {
                if (nodes[id] === undefined)
                    throw new Error(`unknown node <${id}>`)
                let node: SpeechFlowNode
                try {
                    const NodeClass = nodes[id]
                    let num = nodeNums.get(NodeClass) ?? 0
                    nodeNums.set(NodeClass, ++num)
                    const name = num === 1 ? id : `${id}:${num}`
                    node = new NodeClass(name, cfg, opts, args)
                    node._accessBus = accessBus
                }
                catch (err) {
                    /*  fatal error  */
                    if (err instanceof Error)
                        cli!.log("error", `creation of node <${id}> failed: ${err.message}`)
                    else
                        cli!.log("error", `creation of node <${id}> failed: ${err}`)
                    process.exit(1)
                }
                const params = Object.keys(node.params)
                    .map((key) => `${key}: ${JSON.stringify(node.params[key])}`).join(", ")
                cli!.log("info", `create node <${node.id}> (${params})`)
                graphNodes.add(node)
                return node
            },
            connectNodes (node1: SpeechFlowNode, node2: SpeechFlowNode) {
                cli!.log("info", `connect node <${node1.id}> to node <${node2.id}>`)
                node1.connect(node2)
            }
        })
    }
    catch (err) {
        const errorMsg = err instanceof Error && err.name === "FlowLinkError"
            ? err.toString() : (err instanceof Error ? err.message : "internal error")
        cli!.log("error", `failed to materialize SpeechFlow configuration: ${errorMsg}`)
        process.exit(1)
    }

    /*  graph processing: PASS 2: prune connections of nodes  */
    for (const node of graphNodes) {
        /*  determine connections  */
        let connectionsIn  = Array.from(node.connectionsIn)
        let connectionsOut = Array.from(node.connectionsOut)

        /*  ensure necessary incoming links  */
        if (node.input !== "none" && connectionsIn.length === 0)
            throw new Error(`node <${node.id}> requires input but has no input nodes connected`)

        /*  prune unnecessary incoming links  */
        if (node.input === "none" && connectionsIn.length > 0)
            connectionsIn.forEach((other) => { other.disconnect(node) })

        /*  ensure necessary outgoing links  */
        if (node.output !== "none" && connectionsOut.length === 0)
            throw new Error(`node <${node.id}> requires output but has no output nodes connected`)

        /*  prune unnecessary outgoing links  */
        if (node.output === "none" && connectionsOut.length > 0)
            connectionsOut.forEach((other) => { node.disconnect(other) })

        /*  check for payload compatibility  */
        connectionsIn  = Array.from(node.connectionsIn)
        connectionsOut = Array.from(node.connectionsOut)
        for (const other of connectionsOut)
            if (other.input !== node.output)
                throw new Error(`${node.output} output node <${node.id}> cannot be ` +
                    `connected to ${other.input} input node <${other.id}> (payload is incompatible)`)
    }

    /*  graph processing: PASS 3: open nodes  */
    const timeZero = DateTime.now()
    for (const node of graphNodes) {
        /*  connect node events  */
        node.on("log", (level: string, msg: string, data?: any) => {
            let str = `<${node.id}>: ${msg}`
            if (data !== undefined)
                str += ` (${JSON.stringify(data)})`
            cli!.log(level, str)
        })

        /*  open node  */
        cli!.log("info", `open node <${node.id}>`)
        node.setTimeZero(timeZero)
        await Promise.race<void>([
            node.open(),
            new Promise<never>((resolve, reject) => setTimeout(() =>
                reject(new Error("timeout")), 10 * 1000))
        ]).catch((err: Error) => {
            cli!.log("error", `<${node.id}>: failed to open node <${node.id}>: ${err.message}`)
            throw new Error(`failed to open node <${node.id}>: ${err.message}`)
        })
    }

    /*  graph processing: PASS 4: connect node streams  */
    for (const node of graphNodes) {
        if (node.stream === null)
            throw new Error(`stream of node <${node.id}> still not initialized`)
        for (const other of Array.from(node.connectionsOut)) {
            if (other.stream === null)
                throw new Error(`stream of incoming node <${other.id}> still not initialized`)
            cli!.log("info", `connect stream of node <${node.id}> to stream of node <${other.id}>`)
            if (!( node.stream instanceof Stream.Readable
                || node.stream instanceof Stream.Duplex  ))
                throw new Error(`stream of output node <${node.id}> is neither of Readable nor Duplex type`)
            if (!( other.stream instanceof Stream.Writable
                || other.stream instanceof Stream.Duplex  ))
                throw new Error(`stream of input node <${other.id}> is neither of Writable nor Duplex type`)
            node.stream.pipe(other.stream)
        }
    }

    /*  graph processing: PASS 5: track stream finishing  */
    const activeNodes  = new Set<SpeechFlowNode>()
    const finishEvents = new EventEmitter()
    finishEvents.setMaxListeners(graphNodes.size + 10)
    for (const node of graphNodes) {
        if (node.stream === null)
            throw new Error(`stream of node <${node.id}> still not initialized`)
        cli!.log("info", `observe stream of node <${node.id}> for finish event`)
        activeNodes.add(node)
        const deactivateNode = (node: SpeechFlowNode, msg: string) => {
            if (activeNodes.has(node))
                activeNodes.delete(node)
            cli!.log("info", `${msg} (${activeNodes.size} active nodes remaining)`)
            if (activeNodes.size === 0) {
                const timeFinished = DateTime.now()
                const duration = timeFinished.diff(timeZero)
                cli!.log("info", "**** everything finished -- stream processing in SpeechFlow graph stops " +
                    `(total duration: ${duration.toFormat("hh:mm:ss.SSS")}) ****`)
                finishEvents.emit("finished")
            }
        }
        node.stream.on("end", () => {
            deactivateNode(node, `readable stream side of node <${node.id}> raised "end" event`)
        })
        node.stream.on("finish", () => {
            deactivateNode(node, `writable stream side of node <${node.id}> raised "finish" event`)
        })
    }

    /*  define external request/response structure  */
    const requestValidator = arktype.type({
        request: "string",
        node:    "string",
        args:    "unknown[]"
    })

    /*  forward external request to target node in graph  */
    const consumeExternalRequest = async (_req: any) => {
        const req = requestValidator(_req)
        if (req instanceof arktype.type.errors)
            throw new Error(`invalid request: ${req.summary}`)
        if (req.request !== "COMMAND")
            throw new Error("invalid external request (command expected)")
        const name = req.node as string
        const args = req.args as any[]
        const foundNode = Array.from(graphNodes).find((node) => node.id === name)
        if (foundNode === undefined) {
            cli!.log("warning", `external request failed: no such node <${name}>`)
            throw new Error(`external request failed: no such node <${name}>`)
        }
        else {
            await Promise.race<void>([
                foundNode.receiveRequest(args),
                new Promise<never>((resolve, reject) => setTimeout(() =>
                    reject(new Error("timeout")), 10 * 1000))
            ]).catch((err: Error) => {
                cli!.log("warning", `external request to node <${name}> failed: ${err.message}`)
            })
        }
    }

    /*  establish REST/WebSocket API  */
    const wsPeers = new Map<string, wsPeerInfo>()
    const hapi = new HAPI.Server({
        address: args.a,
        port:    args.p
    })
    await hapi.register({ plugin: Inert })
    await hapi.register({ plugin: HAPIHeader, options: { Server: `${pkg.name}/${pkg.version}` } })
    await hapi.register({ plugin: HAPIWebSocket })
    hapi.events.on("response", (request: HAPI.Request) => {
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
        cli!.log("info", `HAPI: request: ${msg}`)
    })
    hapi.events.on({ name: "request", channels: [ "error" ] }, (request: HAPI.Request, event: HAPI.RequestEvent, tags: { [key: string]: true }) => {
        if (event.error instanceof Error)
            cli!.log("error", `HAPI: request-error: ${event.error.message}`)
        else
            cli!.log("error", `HAPI: request-error: ${event.error}`)
    })
    hapi.events.on("log", (event: HAPI.LogEvent, tags: { [key: string]: true }) => {
        if (tags.error) {
            const err = event.error
            if (err instanceof Error)
                cli!.log("error", `HAPI: log: ${err.message}`)
            else
                cli!.log("error", `HAPI: log: ${err}`)
        }
    })
    hapi.route({
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
    hapi.route({
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
    hapi.route({
        method: "GET",
        path:   "/api/{req}/{node}/{params*}",
        options: {
        },
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
            cli!.log("info", `HAPI: peer ${peer}: GET: ${JSON.stringify(req)}`)
            return consumeExternalRequest(req).then(() => {
                return h.response({ response: "OK" }).code(200)
            }).catch((err) => {
                return h.response({ response: "ERROR", data: err.message }).code(417)
            })
        }
    })
    hapi.route({
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
                    connect: (args: any) => {
                        const ctx: wsPeerCtx            = args.ctx
                        const ws:  WebSocket            = args.ws
                        const req: http.IncomingMessage = args.req
                        const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
                        ctx.peer = peer
                        wsPeers.set(peer, { ctx, ws, req })
                        cli!.log("info", `HAPI: WebSocket: connect: peer ${peer}`)
                    },
                    disconnect: (args: any) => {
                        const ctx: wsPeerCtx = args.ctx
                        const ws: WebSocket = args.ws
                        const peer = ctx.peer
                        wsPeers.delete(peer)
                        ws.removeAllListeners()
                        cli!.log("info", `HAPI: WebSocket: disconnect: peer ${peer}`)
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
            cli!.log("info", `HAPI: peer ${peer}: POST: ${JSON.stringify(req)}`)
            return consumeExternalRequest(req).then(() => {
                return h.response({ response: "OK" }).code(200)
            }).catch((err: Error) => {
                return h.response({ response: "ERROR", data: err.message }).code(417)
            })
        }
    })
    await hapi.start()
    cli!.log("info", `HAPI: started REST/WebSocket network service: http://${args.a}:${args.p}`)

    /*  hook for sendResponse method of nodes  */
    for (const node of graphNodes) {
        node.on("send-response", (args: any[]) => {
            const data = JSON.stringify({ response: "NOTIFY", node: node.id, args })
            for (const [ peer, info ] of wsPeers.entries()) {
                cli!.log("debug", `HAPI: remote peer ${peer}: sending ${data}`)
                if (info.ws.readyState === WebSocket.OPEN)
                    info.ws.send(data)
            }
        })
    }

    /*  hook for send-dashboard method of nodes  */
    for (const node of graphNodes) {
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
            for (const [ peer, info ] of wsPeers.entries()) {
                cli!.log("debug", `HAPI: dashboard peer ${peer}: send ${data}`)
                info.ws.send(data)
            }
            for (const node of graphNodes) {
                Promise.race<void>([
                    node.receiveDashboard(info.type, info.id, info.kind, info.value),
                    new Promise<never>((resolve, reject) => setTimeout(() =>
                        reject(new Error("timeout")), 10 * 1000))
                ]).catch((err: Error) => {
                    cli!.log("warning", `sending dashboard info to node <${node.id}> failed: ${err.message}`)
                })
            }
        })
    }

    /*  start of internal stream processing  */
    cli!.log("info", "**** everything established -- stream processing in SpeechFlow graph starts ****")

    /*  gracefully shutdown process  */
    let shuttingDown = false
    const shutdown = async (signal: string) => {
        if (shuttingDown)
            return
        shuttingDown = true
        if (signal === "finished")
            cli!.log("info", "**** streams of all nodes finished -- shutting down service ****")
        else if (signal === "exception")
            cli!.log("warning", "**** exception occurred -- shutting down service ****")
        else
            cli!.log("warning", `**** received signal ${signal} -- shutting down service ****`)

        /*  shutdown HAPI service  */
        cli!.log("info", `HAPI: stopping REST/WebSocket network service: http://${args.a}:${args.p}`)
        await hapi.stop({ timeout: 2000 })

        /*  clear WebSocket connections  */
        if (wsPeers.size > 0) {
            cli!.log("info", "HAPI: closing WebSocket connections")
            const closePromises: Promise<void>[] = []
            for (const [ peer, info ] of wsPeers.entries()) {
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
            ]).catch((err) => {
                cli!.log("warning", `HAPI: WebSockets failed to close: ${err}`)
            })
            wsPeers.clear()
        }

        /*  graph processing: PASS 1: disconnect node streams  */
        for (const node of graphNodes) {
            if (node.stream === null) {
                cli!.log("warning", `stream of node <${node.id}> no longer initialized`)
                continue
            }
            for (const other of Array.from(node.connectionsOut)) {
                if (other.stream === null) {
                    cli!.log("warning", `stream of incoming node <${other.id}> no longer initialized`)
                    continue
                }
                if (!( node.stream instanceof Stream.Readable
                    || node.stream instanceof Stream.Duplex  )) {
                    cli!.log("warning", `stream of output node <${node.id}> is neither of Readable nor Duplex type`)
                    continue
                }
                if (!( other.stream instanceof Stream.Writable
                    || other.stream instanceof Stream.Duplex  )) {
                    cli!.log("warning", `stream of input node <${other.id}> is neither of Writable nor Duplex type`)
                    continue
                }
                cli!.log("info", `disconnect stream of node <${node.id}> from stream of node <${other.id}>`)
                node.stream.unpipe(other.stream)
            }
        }

        /*  graph processing: PASS 2: close nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `close node <${node.id}>`)
            await Promise.race<void>([
                node.close(),
                new Promise<never>((resolve, reject) => setTimeout(() =>
                    reject(new Error("timeout")), 10 * 1000))
            ]).catch((err: Error) => {
                cli!.log("warning", `node <${node.id}> failed to close: ${err.message}`)
            })
        }

        /*  graph processing: PASS 3: disconnect nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `disconnect node <${node.id}>`)
            const connectionsIn  = Array.from(node.connectionsIn)
            const connectionsOut = Array.from(node.connectionsOut)
            connectionsIn.forEach((other) => { other.disconnect(node) })
            connectionsOut.forEach((other) => { node.disconnect(other) })
        }

        /*  graph processing: PASS 4: shutdown nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `destroy node <${node.id}>`)
            graphNodes.delete(node)
        }

        /*  clear event emitters  */
        finishEvents.removeAllListeners()

        /*  clear active nodes  */
        activeNodes.clear()

        /*  terminate process  */
        if (signal === "finished") {
            cli!.log("info", "terminate process (exit code 0)")
            process.exit(0)
        }
        else {
            cli!.log("info", "terminate process (exit code 1)")
            process.exit(1)
        }
    }

    /*  hook into regular finish  */
    finishEvents.on("finished", () => { shutdown("finished") })

    /*  hook into process signals  */
    process.on("SIGINT",        () => { shutdown("SIGINT")   })
    process.on("SIGUSR1",       () => { shutdown("SIGUSR1")  })
    process.on("SIGUSR2",       () => { shutdown("SIGUSR2")  })
    process.on("SIGTERM",       () => { shutdown("SIGTERM")  })

    /*  re-hook into uncaught exception handler  */
    process.removeAllListeners("uncaughtException")
    process.on("uncaughtException", (err) => {
        if (debug)
            cli!.log("error", `uncaught exception: ${err.message}\n${err.stack}`)
        else
            cli!.log("error", `uncaught exception: ${err.message}`)
        shutdown("exception")
    })

    /*  re-hook into unhandled promise rejection handler  */
    process.removeAllListeners("unhandledRejection")
    process.on("unhandledRejection", (reason) => {
        if (reason instanceof Error) {
            if (debug)
                cli!.log("error", `unhandled rejection: ${reason.message}\n${reason.stack}`)
            else
                cli!.log("error", `unhandled rejection: ${reason.message}`)
        }
        else
            cli!.log("error", `unhandled rejection: ${reason}`)
        shutdown("exception")
    })
})().catch((err: Error) => {
    /*  top-level exception handling  */
    if (cli !== null) {
        if (debug)
            cli.log("error", `${err.message}\n${err.stack}`)
        else
            cli.log("error", `${err.message}`)
    }
    else {
        if (debug)
            process.stderr.write(`${pkg.name}: ${chalk.red("ERROR")}: ${err.message}\n${err.stack}\n`)
        else
            process.stderr.write(`${pkg.name}: ${chalk.red("ERROR")}: ${err.message}`)
    }
    process.exit(1)
})

