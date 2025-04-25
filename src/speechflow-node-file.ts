/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import fs               from "node:fs"
import SpeechFlowNode   from "./speechflow-node"

export default class SpeechFlowNodeDevice extends SpeechFlowNode {
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)
        this.configure({
            path: { type: "string", pos: 0 },
            mode: { type: "string", pos: 1, val: "r",     match: /^(?:r|w|rw)$/ },
            type: { type: "string", pos: 2, val: "audio", match: /^(?:audio|text)$/ }
        })
    }
    async open () {
        if (this.params.mode === "r") {
            this.output = this.params.type
            this.stream = fs.createReadStream(this.params.path,
                { encoding: this.params.type === "text" ? this.config.textEncoding : "binary" })
        }
        else if (this.params.mode === "w") {
            this.input = this.params.type
            this.stream = fs.createWriteStream(this.params.path,
                { encoding: this.params.type === "text" ? this.config.textEncoding : "binary" })
        }
        else
            throw new Error(`invalid file mode "${this.params.mode}"`)
    }
    async close () {
        if (this.stream !== null)
            this.stream.destroy()
    }
}

