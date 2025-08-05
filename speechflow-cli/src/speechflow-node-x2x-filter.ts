/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  SpeechFlow node for data flow filtering (based on meta information)  */
export default class SpeechFlowNodeFilter extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "filter"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            type: { type: "string", pos: 0, val: "audio",  match: /^(?:audio|text)$/ },
            name: { type: "string", pos: 1, val: "filter", match: /^.+?$/ },
            var:  { type: "string", pos: 2, val: "",       match: /^(?:meta:.+|payload:(?:length|text)|time:(?:start|end)|kind|type)$/ },
            op:   { type: "string", pos: 3, val: "==",     match: /^(?:<|<=|==|!=|~~|!~|>=|>)$/ },
            val:  { type: "string", pos: 4, val: "",       match: /^.*$/ }
        })

        /*  declare node input/output format  */
        this.input  = this.params.type
        this.output = this.params.type
    }

    /*  open node  */
    async open () {
        /*  helper function for comparing two values  */
        const comparison = (val1: any, op: string, val2: any) => {
            if (op === "==" || op === "!=") {
                /*  equal comparison  */
                const str1 = (typeof val1 === "string" ? val1 : val1.toString()) as string
                const str2 = (typeof val2 === "string" ? val2 : val2.toString()) as string
                return (op === "==" ? (str1 === str2) : (str1 !== str2))
            }
            else if (op === "~~" || op === "!~") {
                /*  regular expression comparison  */
                const str = (typeof val1 === "string" ? val1 : val1.toString()) as string
                const regexp = (
                    val2 instanceof RegExp ?
                        val2 :
                        typeof val2 === "string" ?
                            new RegExp(val2) :
                            new RegExp(val2.toString()))
                return (op === "~~" ? regexp.test(str) : !regexp.test(str))
            }
            else {
                /*  non-equal comparison  */
                const coerceNum = (val: any) => {
                    return typeof val === "number" ? val : (
                        typeof val === "string" && val.match(/^[\d+-]+$/) ? parseInt(val) : (
                            typeof val === "string" && val.match(/^[\d.+-]+$/) ?
                                parseFloat(val) :
                                Number(val)
                        )
                    )
                }
                const num1 = coerceNum(val1)
                const num2 = coerceNum(val2)
                return (
                    op === "<" ?
                        (num1 < num2) :
                        op === "<=" ?
                            (num1 <= num2) :
                            op === ">=" ?
                                (num1 >= num2) :
                                op === ">" ?
                                    (num1 > num2) :
                                    false
                )
            }
        }

        /*  provide Transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                let val1: any
                const val2: any = self.params.val
                const m = self.params.var.match(/^meta:(.+)$/)
                if (m !== null)
                    val1 = chunk.meta.get(m[1]) ?? ""
                else if (self.params.var === "kind")
                    val1 = chunk.kind
                else if (self.params.var === "type")
                    val1 = chunk.type
                else if (self.params.var === "payload:length")
                    val1 = chunk.payload.length
                else if (self.params.var === "payload:text")
                    val1 = (self.params.type === "text" ? chunk.payload as string : "")
                else if (self.params.var === "time:start")
                    val1 = chunk.timestampStart.toMillis()
                else if (self.params.var === "time:end")
                    val1 = chunk.timestampEnd.toMillis()
                if (comparison(val1, self.params.op, val2)) {
                    self.log("info", `[${self.params.name}]: passing through ${chunk.type} chunk`)
                    this.push(chunk)
                }
                callback()
            },
            final (callback) {
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
