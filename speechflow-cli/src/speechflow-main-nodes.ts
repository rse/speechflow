/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  external dependencies  */
import CLIio             from "cli-io"
import installedPackages from "installed-packages"
import { glob }          from "glob"

/*  internal dependencies  */
import SpeechFlowNode    from "./speechflow-node"

/*  the node loader  */
export class NodeRegistry {
    public nodes: { [ id: string ]: typeof SpeechFlowNode } = {}

    /*  simple constructor  */
    constructor (
        private cli: CLIio
    ) {}

    /*  node internal and external SpeechFlow nodes  */
    async load () {
        /*  load internal SpeechFlow nodes  */
        const pkgsI = await glob("speechflow-node-*-*.js", {
            cwd: __dirname,
            ignore: {
                ignored: (p) => p.name.endsWith("-wt.js")
            }
        })
        for (const pkg of pkgsI) {
            let node: any = await import(`./${pkg}`)
            while (node.default !== undefined)
                node = node.default
            if (typeof node === "function" && typeof node.name === "string") {
                this.cli.log("info", `loading SpeechFlow node <${node.name}> from internal module`)
                this.nodes[node.name] = node as typeof SpeechFlowNode
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
                    if (this.nodes[node.name] !== undefined) {
                        this.cli.log("warning", `failed loading SpeechFlow node <${node.name}> ` +
                            `from external module "${pkg}" -- node already exists`)
                        continue
                    }
                    this.cli.log("info", `loading SpeechFlow node <${node.name}> from external module "${pkg}"`)
                    this.nodes[node.name] = node as typeof SpeechFlowNode
                }
            }
        }
    }
}