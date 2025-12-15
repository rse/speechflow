/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                from "node:stream"
import { EventEmitter }      from "node:events"

/*  external dependencies  */
import { DateTime }          from "luxon"
import CLIio                 from "cli-io"
import FlowLink              from "flowlink"
import objectPath            from "object-path"

/*  internal dependencies  */
import SpeechFlowNode        from "./speechflow-node"
import { NodeConfig }        from "./speechflow-main-config"
import { CLIOptions }        from "./speechflow-main-cli"
import { APIServer }         from "./speechflow-main-api"
import * as util             from "./speechflow-util"

/*  the SpeechFlow node graph management  */
export class NodeGraph {
    /*  internal state  */
    private graphNodes    = new Set<SpeechFlowNode>()
    private activeNodes   = new Set<SpeechFlowNode>()
    private finishEvents  = new EventEmitter()
    private timeZero:     DateTime | null = null
    private shuttingDown  = false

    /*  simple construction  */
    constructor (
        private cli:  CLIio,
        private debug = false
    ) {}

    /*  get all graph nodes  */
    getGraphNodes (): Set<SpeechFlowNode> {
        return this.graphNodes
    }

    /*  find particular graph node  */
    findGraphNode (name: string): SpeechFlowNode | undefined {
        return Array.from(this.graphNodes).find((node) => node.id === name)
    }

    /*  graph establishment: PASS 1: parse DSL and create and connect nodes  */
    async createAndConnectNodes (
        config:    string,
        nodes:     { [ id: string ]: typeof SpeechFlowNode },
        cfg:       NodeConfig,
        variables: { argv: any[], env: any },
        accessBus: (name: string) => EventEmitter
    ): Promise<void> {
        /*  internal helper for extracting error messages  */
        const flowlinkErrorMsg = (err: unknown): string =>
            err instanceof Error && err.name === "FlowLinkError"
                ? err.toString() : (err instanceof Error ? err.message : "internal error")

        /*  instantiate FlowLink parser  */
        const flowlink = new FlowLink<SpeechFlowNode>({
            trace: (msg: string) => {
                this.cli.log("debug", msg)
            }
        })
        const nodeNums = new Map<typeof SpeechFlowNode, number>()
        let ast: unknown
        try {
            ast = flowlink.compile(config)
        }
        catch (err) {
            this.cli.log("error", `failed to parse SpeechFlow configuration: ${flowlinkErrorMsg(err)}`)
            process.exit(1)
        }
        try {
            flowlink.execute(ast, {
                resolveVariable: (id: string) => {
                    if (!objectPath.has(variables, id))
                        throw new Error(`failed to resolve variable "${id}"`)
                    const value = objectPath.get(variables, id)
                    const sensitive = /(?:key|secret|token|password)/i.test(id)
                    this.cli.log("info", `resolve variable: "${id}" -> "${sensitive ? "***" : value}"`)
                    return value
                },
                createNode: (id: string, opts: { [ id: string ]: any }, args: any[]) => {
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
                        this.cli.log("error", `creation of node <${id}> failed: ${util.ensureError(err).message}`)
                        process.exit(1)
                    }
                    const params = Object.keys(node.params).map((key) => {
                        if (/(?:key|secret|token|password)/i.test(key))
                            return `${key}: ***`
                        else
                            return `${key}: ${JSON.stringify(node.params[key])}`
                    }).join(", ")
                    this.cli.log("info", `create node <${node.id}> (${params})`)
                    this.graphNodes.add(node)
                    return node
                },
                connectNodes: (node1: SpeechFlowNode, node2: SpeechFlowNode) => {
                    this.cli.log("info", `connect node <${node1.id}> to node <${node2.id}>`)
                    node1.connect(node2)
                }
            })
        }
        catch (err) {
            this.cli.log("error", `failed to materialize SpeechFlow configuration: ${flowlinkErrorMsg(err)}`)
            process.exit(1)
        }
    }

    /*  graph establishment: PASS 2: prune connections of nodes  */
    async pruneConnections () {
        for (const node of this.graphNodes) {
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
    }

    /*  graph establishment: PASS 3: open nodes  */
    async openNodes(): Promise<void> {
        this.timeZero = DateTime.now()
        for (const node of this.graphNodes) {
            /*  connect node events  */
            node.on("log", (level: string, msg: string, data?: any) => {
                let str = `<${node.id}>: ${msg}`
                if (data !== undefined)
                    str += ` (${JSON.stringify(data)})`
                this.cli.log(level, str)
            })

            /*  open node  */
            this.cli.log("info", `open node <${node.id}>`)
            node.setTimeZero(this.timeZero)
            await Promise.race<void>([
                node.open(),
                util.timeout(30 * 1000)
            ]).catch((err: Error) => {
                this.cli.log("error", `<${node.id}>: failed to open node <${node.id}>: ${err.message}`)
                throw new Error(`failed to open node <${node.id}>: ${err.message}`)
            })
        }
    }

    /*  graph establishment: PASS 4: connect node streams  */
    async connectStreams() {
        for (const node of this.graphNodes) {
            if (node.stream === null)
                throw new Error(`stream of node <${node.id}> still not initialized`)
            for (const other of Array.from(node.connectionsOut)) {
                if (other.stream === null)
                    throw new Error(`stream of incoming node <${other.id}> still not initialized`)
                this.cli.log("info", `connect stream of node <${node.id}> to stream of node <${other.id}>`)
                if (!( node.stream instanceof Stream.Readable
                    || node.stream instanceof Stream.Duplex  ))
                    throw new Error(`stream of output node <${node.id}> is neither of Readable nor Duplex type`)
                if (!( other.stream instanceof Stream.Writable
                    || other.stream instanceof Stream.Duplex  ))
                    throw new Error(`stream of input node <${other.id}> is neither of Writable nor Duplex type`)
                node.stream.pipe(other.stream)
            }
        }
    }

    /*  graph establishment: PASS 5: track stream finishing  */
    trackFinishing(args: CLIOptions, api: APIServer): void {
        this.finishEvents.removeAllListeners()
        this.finishEvents.setMaxListeners(this.graphNodes.size + 10)
        for (const node of this.graphNodes) {
            if (node.stream === null)
                throw new Error(`stream of node <${node.id}> still not initialized`)
            this.cli.log("info", `observe stream of node <${node.id}> for finish event`)
            this.activeNodes.add(node)
            const deactivateNode = (node: SpeechFlowNode, msg: string) => {
                if (this.activeNodes.has(node))
                    this.activeNodes.delete(node)
                this.cli.log("info", `${msg} (${this.activeNodes.size} active nodes remaining)`)
                if (this.activeNodes.size === 0) {
                    const timeFinished = DateTime.now()
                    const duration = this.timeZero !== null ? timeFinished.diff(this.timeZero) : null
                    this.cli.log("info", "**** everything finished -- stream processing in SpeechFlow graph stops " +
                        `(total duration: ${duration?.toFormat("hh:mm:ss.SSS") ?? "unknown"}) ****`)
                    this.finishEvents.emit("finished")
                    this.shutdown("finished", args, api)
                }
            }
            node.stream.on("finish", () => {
                deactivateNode(node, `writable stream side (input) of node <${node.id}> raised "finish" event`)
            })
            node.stream.on("end", () => {
                deactivateNode(node, `readable stream side (output) of node <${node.id}> raised "end" event`)
            })
        }

        /*  start of internal stream processing  */
        this.cli.log("info", "**** everything established -- stream processing in SpeechFlow graph starts ****")
    }

    /*  graph destruction: PASS 1: end node streams  */
    async endStreams(): Promise<void> {
        /*  end all writable streams and wait for them to drain  */
        const drainPromises: Promise<void>[] = []
        for (const node of this.graphNodes) {
            if (node.stream === null)
                continue
            const stream = node.stream
            if ((stream instanceof Stream.Writable || stream instanceof Stream.Duplex) &&
                (!stream.writableEnded && !stream.destroyed)) {
                drainPromises.push(
                    Promise.race([
                        new Promise<void>((resolve) => {
                            stream.end(() => { resolve() })
                        }),
                        util.timeout(5000)
                    ]).catch(() => {
                        /*  ignore timeout -- stream will be destroyed later  */
                    })
                )
            }
        }
        await Promise.all(drainPromises)
    }

    /*  graph destruction: PASS 2: disconnect node streams  */
    async disconnectStreams(): Promise<void> {
        for (const node of this.graphNodes) {
            if (node.stream === null) {
                this.cli.log("warning", `stream of node <${node.id}> no longer initialized`)
                continue
            }
            for (const other of Array.from(node.connectionsOut)) {
                if (other.stream === null) {
                    this.cli.log("warning", `stream of incoming node <${other.id}> no longer initialized`)
                    continue
                }
                if (!( node.stream instanceof Stream.Readable
                    || node.stream instanceof Stream.Duplex  )) {
                    this.cli.log("warning", `stream of output node <${node.id}> is neither of Readable nor Duplex type`)
                    continue
                }
                if (!( other.stream instanceof Stream.Writable
                    || other.stream instanceof Stream.Duplex  )) {
                    this.cli.log("warning", `stream of input node <${other.id}> is neither of Writable nor Duplex type`)
                    continue
                }
                this.cli.log("info", `disconnect stream of node <${node.id}> from stream of node <${other.id}>`)
                node.stream.unpipe(other.stream)
            }
        }
    }

    /*  graph destruction: PASS 3: close nodes  */
    async closeNodes(): Promise<void> {
        for (const node of this.graphNodes) {
            this.cli.log("info", `close node <${node.id}>`)
            await Promise.race<void>([
                node.close(),
                util.timeout(10 * 1000)
            ]).catch((err: Error) => {
                this.cli.log("warning", `node <${node.id}> failed to close: ${err.message}`)
            })
        }
    }

    /*  graph destruction: PASS 4: disconnect nodes  */
    disconnectNodes(): void {
        for (const node of this.graphNodes) {
            this.cli.log("info", `disconnect node <${node.id}>`)
            const connectionsIn  = Array.from(node.connectionsIn)
            const connectionsOut = Array.from(node.connectionsOut)
            connectionsIn.forEach((other) => { other.disconnect(node) })
            connectionsOut.forEach((other) => { node.disconnect(other) })
        }
    }

    /*  graph destruction: PASS 5: destroy nodes  */
    destroyNodes(): void {
        for (const node of this.graphNodes) {
            this.cli.log("info", `destroy node <${node.id}>`)
            this.graphNodes.delete(node)
        }
    }

    /*  setup signal handling for shutdown  */
    setupSignalHandlers(args: CLIOptions, api: APIServer): void {
        /*  internal helper functions  */
        const shutdownHandler = (signal: string) =>
            this.shutdown(signal, args, api)
        const logError = (error: Error) => {
            if (this.debug)
                this.cli.log("error", `uncaught exception: ${error.message}\n${error.stack}`)
            else
                this.cli.log("error", `uncaught exception: ${error.message}`)
        }

        /*  hook into process signals  */
        process.on("SIGINT",  () => { shutdownHandler("SIGINT")   })
        process.on("SIGUSR1", () => { shutdownHandler("SIGUSR1")  })
        process.on("SIGUSR2", () => { shutdownHandler("SIGUSR2")  })
        process.on("SIGTERM", () => { shutdownHandler("SIGTERM")  })

        /*  re-hook into uncaught exception handler  */
        process.removeAllListeners("uncaughtException")
        process.on("uncaughtException", (err) => {
            const error = util.ensureError(err, "uncaught exception")
            logError(error)
            shutdownHandler("exception")
        })

        /*  re-hook into unhandled promise rejection handler  */
        process.removeAllListeners("unhandledRejection")
        process.on("unhandledRejection", (reason) => {
            const error = util.ensureError(reason, "unhandled promise rejection")
            logError(error)
            shutdownHandler("exception")
        })
    }

    /*  shutdown procedure  */
    async shutdown(signal: string, args: CLIOptions, api: APIServer): Promise<void> {
        if (this.shuttingDown)
            return
        this.shuttingDown = true
        if (signal === "exception")
            this.cli.log("warning", "**** exception occurred -- shutting down service ****")
        else if (signal !== "finished")
            this.cli.log("warning", `**** received signal ${signal} -- shutting down service ****`)

        /*  shutdown API service  */
        await api.stop(args)

        /*  gracefully end, disconnect, close and destroy nodes  */
        await this.endStreams()
        await this.disconnectStreams()
        await this.closeNodes()
        this.disconnectNodes()
        this.destroyNodes()

        /*  clear event emitters  */
        this.finishEvents.removeAllListeners()

        /*  clear active nodes  */
        this.activeNodes.clear()

        /*  terminate process  */
        if (signal === "finished") {
            this.cli.log("info", "terminate process (exit code 0)")
            process.exit(0)
        }
        else {
            this.cli.log("info", "terminate process (exit code 1)")
            process.exit(1)
        }
    }
}
