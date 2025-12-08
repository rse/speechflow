/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { EventEmitter }      from "node:events"

/*  external dependencies  */
import CLIio                 from "cli-io"
import Table                 from "cli-table3"
import chalk                 from "chalk"

/*  internal dependencies  */
import SpeechFlowNode        from "./speechflow-node"
import { NodeConfig }        from "./speechflow-main-config"
import * as util             from "./speechflow-util"

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
                util.timeout(10 * 1000)
            ]).catch((err: Error) => {
                this.cli.log("warning", `[${node.id}]: failed to gather status of node <${node.id}>: ${err.message}`)
                return {} as { [ key: string ]: string | number }
            })

            /*  render output as a table row  */
            const keys = Object.keys(status)
            for (let i = 0; i < keys.length; i++)
                table.push([ i === 0 ? chalk.bold(name) : "", keys[i], chalk.blue(status[keys[i]]) ])
        }
        const output = table.toString()
        process.stdout.write(output + "\n")
    }
}