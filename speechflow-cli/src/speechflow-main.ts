/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { EventEmitter }       from "node:events"

/*  internal dependencies  */
import { CLIContext }         from "./speechflow-main-cli"
import { NodeConfig }         from "./speechflow-main-config"
import { NodeRegistry }       from "./speechflow-main-nodes"
import { NodeStatusManager }  from "./speechflow-main-status"
import { NodeGraph }          from "./speechflow-main-graph"
import { APIServer }          from "./speechflow-main-api"
import * as util              from "./speechflow-util"

/*  class of main procedure  */
export default class Main {
    /*  static entry point  */
    static main () {
        /*  create CLI environment  */
        const cli = new CLIContext()

        /*  early catch and handle uncaught exceptions (will be replaced later)  */
        process.on("uncaughtException", (err) => {
            const error = util.ensureError(err, "uncaught exception")
            cli.handleTopLevelError(error)
        })

        /*  early catch and handle unhandled promise rejections (will be replaced later)  */
        process.on("unhandledRejection", (reason) => {
            const error = util.ensureError(reason, "unhandled promise rejection")
            cli.handleTopLevelError(error)
        })

        /*  instantiate ourself  */
        const main = new Main(cli)
        main.run().catch((err) => {
            /*  handle errors at the top-level  */
            const error = util.ensureError(err, "top-level error")
            cli.handleTopLevelError(error)
        })
    }

    /*  simple constructor  */
    constructor (
        private cli: CLIContext
    ) {}

    /*  effective main procedure  */
    async run () {
        /*  initialize CLI context  */
        await this.cli.init()
        if (!this.cli.isInitialized())
            throw new Error("CLI context initialization failed")
        const { cli, args, config, debug } = this.cli

        /*  load nodes  */
        const nodes = new NodeRegistry(cli)
        await nodes.load()

        /*  define static read-only configuration  */
        const cfg = new NodeConfig()
        cfg.cacheDir = args.C

        /*  provide access to internal communication busses  */
        const busses = new Map<string, EventEmitter>()
        const accessBus = (name: string): EventEmitter => {
            let bus = busses.get(name)
            if (bus === undefined) {
                bus = new EventEmitter()
                busses.set(name, bus)
            }
            return bus
        }

        /*  handle one-time status query of nodes  */
        if (args.S) {
            const statusManager = new NodeStatusManager(cli)
            await statusManager.showNodeStatus(nodes.nodes, cfg, accessBus)
            process.exit(0)
        }

        /*  initialize graph processor  */
        const graph = new NodeGraph(cli, debug)

        /*  create and connect nodes into a graph  */
        const variables = { argv: args._, env: process.env }
        await graph.createAndConnectNodes(config, nodes.nodes, cfg, variables, accessBus)
        await graph.pruneConnections()

        /*  open nodes and connect streams  */
        await graph.openNodes()
        await graph.connectStreams()

        /*  initialize API server  */
        const api = new APIServer(cli)
        await api.start(args, graph)

        /*  setup signal handlers and track stream finishing  */
        graph.setupSignalHandlers(args, api)
        graph.trackFinishing(args, api)
    }
}
