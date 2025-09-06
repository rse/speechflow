/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  internal dependencies  */
import { EventEmitter }      from "node:events"

/*  external dependencies  */
import CLIio                 from "cli-io"
import Table                 from "cli-table3"
import chalk                 from "chalk"

/*  internal dependencies  */
import SpeechFlowNode        from "./speechflow-node"
import { NodeConfig }        from "./speechflow-main-config"

/*  the node status manager  */
export class NodeStatusManager {
    constructor (
        private cli: CLIio
    ) {}

    /*  gather and show status of all nodes  */
    async showNodeStatus(
        nodes:     { [ id: string ]: typeof SpeechFlowNode },
        cfg:       NodeConfig,
        accessBus: (name: string) => EventEmitter
    ) {
        /*  create CLI table  */
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

        /*  iterate over all nodes...  */
        for (const name of Object.keys(nodes)) {
            /*  instantiate node and query its status  */
            this.cli.log("info", `gathering status of node <${name}>`)
            const node = new nodes[name](name, cfg, {}, [])
            node._accessBus = accessBus
            const status = await Promise.race<{ [ key: string ]: string | number }>([
                node.status(),
                new Promise<never>((resolve, reject) => setTimeout(() =>
                    reject(new Error("timeout")), 10 * 1000))
            ]).catch((err: Error) => {
                this.cli.log("warning", `[${node.id}]: failed to gather status of node <${node.id}>: ${err.message}`)
                return {} as { [ key: string ]: string | number }
            })

            /*  render output as a table row  */
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
    }
}