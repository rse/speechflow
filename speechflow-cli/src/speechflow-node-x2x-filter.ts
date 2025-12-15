/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for data flow filtering (based on meta information)  */
export default class SpeechFlowNodeX2XFilter extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "x2x-filter"

    /*  cached regular expression instance  */
    private cachedRegExp = new util.CachedRegExp()

    /*  internal state  */
    private closing = false

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
        /*  clear destruction flag  */
        this.closing = false

        /*  helper function for comparing two values  */
        const comparison = (val1: any, op: string, val2: any) => {
            if (op === "==" || op === "!=") {
                /*  equal comparison  */
                const str1 = (typeof val1 === "string" ? val1 : val1.toString())
                const str2 = (typeof val2 === "string" ? val2 : val2.toString())
                return (op === "==" ? (str1 === str2) : (str1 !== str2))
            }
            else if (op === "~~" || op === "!~") {
                /*  regular expression comparison  */
                const str = (typeof val1 === "string" ? val1 : val1.toString())
                const regexp = (
                    val2 instanceof RegExp ?
                        val2 :
                        typeof val2 === "string" ?
                            this.cachedRegExp.compile(val2) :
                            this.cachedRegExp.compile(val2.toString()))
                if (regexp === null) {
                    /*  fallback to literal string comparison on invalid regex  */
                    this.log("warning", `invalid regular expression: "${val2}"`)
                    return (op === "~~" ? (str === val2) : (str !== val2))
                }
                return (op === "~~" ? regexp.test(str) : !regexp.test(str))
            }
            else {
                /*  non-equal comparison  */
                const coerceNum = (val: any) =>
                    typeof val === "number" ? val : (
                        typeof val === "string" && val.match(/^[\d+-]+$/) ? Number.parseInt(val, 10) : (
                            typeof val === "string" && val.match(/^[\d.+-]+$/) ?
                                Number.parseFloat(val) :
                                Number(val)
                        )
                    )
                const num1 = coerceNum(val1)
                const num2 = coerceNum(val2)
                return (
                    op === "<"  ? (num1 <  num2) :
                    op === "<=" ? (num1 <= num2) :
                    op === ">=" ? (num1 >= num2) :
                    op === ">"  ? (num1 >  num2) :
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
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
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
                else
                    val1 = undefined
                if (comparison(val1, self.params.op, val2)) {
                    self.log("info", `[${self.params.name}]: passing through ${chunk.type} chunk`)
                    this.push(chunk)
                }
                callback()
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
