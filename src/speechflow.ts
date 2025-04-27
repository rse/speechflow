/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Stream                   from "node:stream"

import CLIio                    from "cli-io"
import yargs                    from "yargs"
import jsYAML                   from "js-yaml"
import FlowLink                 from "flowlink"
import objectPath               from "object-path"

import SpeechFlowNode           from "./speechflow-node"
import SpeechFlowNodeFile       from "./speechflow-node-file"
import SpeechFlowNodeDevice     from "./speechflow-node-device"
import SpeechFlowNodeWebsocket  from "./speechflow-node-websocket"
import SpeechFlowNodeFFmpeg     from "./speechflow-node-ffmpeg"
import SpeechFlowNodeDeepgram   from "./speechflow-node-deepgram"
import SpeechFlowNodeDeepL      from "./speechflow-node-deepl"
import SpeechFlowNodeElevenLabs from "./speechflow-node-elevenlabs"
import SpeechFlowNodeGemma      from "./speechflow-node-gemma"

import pkg                      from "../package.json"

let cli: CLIio | null = null
;(async () => {
    /*  parse command-line arguments  */
    const args = await yargs()
        /* eslint @stylistic/indent: off */
        .usage(
            "Usage: $0 " +
            "[-h|--help] " +
            "[-V|--version] " +
            "[-v|--verbose <level>] " +
            "[-e|--expression <expression>] " +
            "[-f|--expression-file <expression-file>] " +
            "[-c|--config <key>@<yaml-config-file>] " +
            "[<argument> [...]]"
        )
        .help("h").alias("h", "help").default("h", false)
            .describe("h", "show usage help")
        .boolean("V").alias("V", "version").default("V", false)
            .describe("V", "show program version information")
        .string("v").nargs("v", 1).alias("v", "log-level").default("v", "warning")
            .describe("v", "level for verbose logging ('none', 'error', 'warning', 'info', 'debug')")
        .string("e").nargs("e", 1).alias("e", "expression").default("e", "")
            .describe("e", "FlowLink expression")
        .string("f").nargs("f", 1).alias("f", "expression-file").default("f", "")
            .describe("f", "FlowLink expression file")
        .string("c").nargs("c", 1).alias("c", "config-file").default("c", "")
            .describe("c", "configuration in format <id>@<file>")
        .version(false)
        .strict()
        .showHelpOnFail(true)
        .demand(0)
        .parse(process.argv.slice(2))

    /*  short-circuit version request  */
    if (args.version) {
        process.stderr.write(`${pkg.name} ${pkg.version} <${pkg.homepage}>\n`)
        process.stderr.write(`${pkg.description}\n`)
        process.stderr.write(`Copyright (c) 2024-2025 ${pkg.author.name} <${pkg.author.url}>\n`)
        process.stderr.write(`Licensed under ${pkg.license} <http://spdx.org/licenses/${pkg.license}.html>\n`)
        process.exit(0)
    }

    /*  establish CLI environment  */
    cli = new CLIio({
        encoding:  "utf8",
        logLevel:  args.logLevel,
        logTime:   true,
        logPrefix: pkg.name
    })

    /*  handle uncaught exceptions  */
    process.on("uncaughtException", async (err: Error) => {
        cli!.log("warning", `process crashed with a fatal error: ${err} ${err.stack}`)
        process.exit(1)
    })

    /*  handle unhandled promise rejections  */
    process.on("unhandledRejection", async (reason, promise) => {
        if (reason instanceof Error)
            cli!.log("error", `promise rejection not handled: ${reason.message}: ${reason.stack}`)
        else
            cli!.log("error", `promise rejection not handled: ${reason}`)
        process.exit(1)
    })

    /*  sanity check usage  */
    let n = 0
    if (typeof args.expression     === "string" && args.expression     !== "") n++
    if (typeof args.expressionFile === "string" && args.expressionFile !== "") n++
    if (typeof args.configFile     === "string" && args.configFile     !== "") n++
    if (n !== 1)
        throw new Error("cannot use more than one FlowLink specification source (either option -e, -f or -c)")

    /*  read configuration  */
    let config = ""
    if (typeof args.expression === "string" && args.expression !== "")
        config = args.expression
    else if (typeof args.expressionFile === "string" && args.expressionFile !== "")
        config = await cli.input(args.expressionFile, { encoding: "utf8" })
    else if (typeof args.configFile === "string" && args.configFile !== "") {
        const m = args.configFile.match(/^(.+?)@(.+)$/)
        if (m === null)
            throw new Error("invalid configuration file specification (expected \"<key>@<yaml-config-file>\")")
        const [ , key, file ] = m
        const yaml = await cli.input(file, { encoding: "utf8" })
        const obj: any = jsYAML.load(yaml)
        if (obj[key] === undefined)
            throw new Error(`no such key "${key}" found in configuration file`)
        config = obj[key] as string
    }

    /*  configuration of nodes  */
    const nodes: { [ id: string ]: typeof SpeechFlowNode } = {
        "file":       SpeechFlowNodeFile,
        "device":     SpeechFlowNodeDevice,
        "websocket":  SpeechFlowNodeWebsocket,
        "ffmpeg":     SpeechFlowNodeFFmpeg,
        "deepgram":   SpeechFlowNodeDeepgram,
        "deepl":      SpeechFlowNodeDeepL,
        "elevenlabs": SpeechFlowNodeElevenLabs,
        "gemma":      SpeechFlowNodeGemma
    }

    /*  graph processing: PASS 1: parse DSL and create and connect nodes  */
    const flowlink = new FlowLink<SpeechFlowNode>({
        trace: (msg: string) => {
            cli!.log("debug", msg)
        }
    })
    let nodenum = 1
    const variables = { argv: args._, env: process.env }
    const graphNodes = new Set<SpeechFlowNode>()
    flowlink.evaluate(config, {
        resolveVariable (id: string) {
            if (!objectPath.has(variables, id))
                throw new Error(`failed to resolve variable "${id}"`)
            const value = objectPath.get(variables, id)
            cli!.log("info", `resolve variable: "${id}" -> "${value}"`)
            return value
        },
        createNode (id: string, opts: { [ id: string ]: any }, args: any[]) {
            if (nodes[id] === undefined)
                throw new Error(`unknown node "${id}"`)
            const node = new nodes[id](`${id}[${nodenum++}]`, opts, args)
            const params = Object.keys(node.params)
                .map((key) => `${key}: ${JSON.stringify(node.params[key])}`).join(", ")
            cli!.log("info", `create node "${node.id}" (${params})`)
            graphNodes.add(node)
            return node
        },
        connectNode (node1: SpeechFlowNode, node2: SpeechFlowNode) {
            cli!.log("info", `connect node "${node1.id}" to node "${node2.id}"`)
            node1.connect(node2)
        }
    })

    /*  graph processing: PASS 2: prune connections of nodes  */
    for (const node of graphNodes) {
        /*  determine connections  */
        const connectionsIn  = Array.from(node.connectionsIn)
        const connectionsOut = Array.from(node.connectionsOut)

        /*  ensure necessary incoming links  */
        if (node.input !== "none" && connectionsIn.length === 0)
            throw new Error(`node "${node.id}" requires input but has no input nodes connected`)

        /*  prune unnecessary incoming links  */
        if (node.input === "none" && connectionsIn.length > 0)
            connectionsIn.forEach((other) => { other.disconnect(node) })

        /*  ensure necessary outgoing links  */
        if (node.output !== "none" && connectionsOut.length === 0)
            throw new Error(`node "${node.id}" requires output but has no output nodes connected`)

        /*  prune unnecessary outgoing links  */
        if (node.output === "none" && connectionsOut.length > 0)
            connectionsOut.forEach((other) => { node.disconnect(other) })

        /*  check for payload compatibility  */
        for (const other of connectionsOut)
            if (other.input !== node.output)
                throw new Error(`${node.output} output node "${node.id}" cannot be ` +
                    `connected to ${other.input} input node "${other.id}" (payload is incompatible)`)
    }

    /*  graph processing: PASS 3: open nodes  */
    for (const node of graphNodes) {
        /*  connect node events  */
        node.on("log", (level: string, msg: string, data?: any) => {
            let str = `[${node.id}]: ${msg}`
            if (data !== undefined)
                str += ` (${JSON.stringify(data)})`
            cli!.log(level, str)
        })

        /*  open node  */
        cli!.log("info", `open node "${node.id}"`)
        await node.open().catch((err: Error) => {
            cli!.log("error", `[${node.id}]: ${err.message}`)
            throw new Error(`failed to open node "${node.id}"`)
        })
    }

    /*  graph processing: PASS 4: connect node streams  */
    for (const node of graphNodes) {
        if (node.stream === null)
            throw new Error(`stream of node "${node.id}" still not initialized`)
        for (const other of Array.from(node.connectionsOut)) {
            if (other.stream === null)
                throw new Error(`stream of incoming node "${other.id}" still not initialized`)
            cli!.log("info", `connect stream of node "${node.id}" to stream of node "${other.id}"`)
            if (!( node.stream instanceof Stream.Readable
                || node.stream instanceof Stream.Duplex  ))
                throw new Error(`stream of output node "${node.id}" is neither of Readable nor Duplex type`)
            if (!( other.stream instanceof Stream.Writable
                || other.stream instanceof Stream.Duplex  ))
                throw new Error(`stream of input node "${other.id}" is neither of Writable nor Duplex type`)
            node.stream.pipe(other.stream)
        }
    }

    /*  gracefully shutdown process  */
    let shuttingDown = false
    const shutdown = async (signal: string) => {
        if (shuttingDown)
            return
        shuttingDown = true
        cli!.log("warning", `received signal ${signal} -- shutting down service`)

        /*  graph processing: PASS 1: disconnect node streams  */
        for (const node of graphNodes) {
            if (node.stream === null) {
                cli!.log("warning", `stream of node "${node.id}" no longer initialized`)
                continue
            }
            for (const other of Array.from(node.connectionsOut)) {
                if (other.stream === null) {
                    cli!.log("warning", `stream of incoming node "${other.id}" no longer initialized`)
                    continue
                }
                if (!( node.stream instanceof Stream.Readable
                    || node.stream instanceof Stream.Duplex  )) {
                    cli!.log("warning", `stream of output node "${node.id}" is neither of Readable nor Duplex type`)
                    continue
                }
                if (!( other.stream instanceof Stream.Writable
                    || other.stream instanceof Stream.Duplex  )) {
                    cli!.log("warning", `stream of input node "${other.id}" is neither of Writable nor Duplex type`)
                    continue
                }
                cli!.log("info", `disconnect stream of node "${node.id}" from stream of node "${other.id}"`)
                node.stream.unpipe(other.stream)
            }
        }

        /*  graph processing: PASS 2: close nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `close node "${node.id}"`)
            await node.close()
        }

        /*  graph processing: PASS 3: disconnect nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `disconnect node "${node.id}"`)
            const connectionsIn  = Array.from(node.connectionsIn)
            const connectionsOut = Array.from(node.connectionsOut)
            connectionsIn.forEach((other) => { other.disconnect(node) })
            connectionsOut.forEach((other) => { node.disconnect(other) })
        }

        /*  graph processing: PASS 4: shutdown nodes  */
        for (const node of graphNodes) {
            cli!.log("info", `destroy node "${node.id}"`)
            graphNodes.delete(node)
        }

        /*  terminate process  */
        process.exit(1)
    }
    process.on("SIGINT", () => {
        shutdown("SIGINT")
    })
    process.on("SIGTERM", () => {
        shutdown("SIGTERM")
    })
})().catch((err: Error) => {
    if (cli !== null)
        cli.log("error", err.message)
    else
        process.stderr.write(`${pkg.name}: ERROR: ${err.message}\n`)
    process.exit(1)
})

