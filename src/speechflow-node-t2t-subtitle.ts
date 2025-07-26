/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { Duration } from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"

/*  SpeechFlow node for subtitle (text-to-text) "translations"  */
export default class SpeechFlowNodeSubtitle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "subtitle"

    /*  internal state  */
    private sequenceNo = 1

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            format: { type: "string", pos: 0, val: "srt", match: /^(?:srt|vtt)$/ },
            words:  { type: "boolean", val: false }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        this.sequenceNo = 1

        /*  provide text-to-subtitle conversion  */
        const convert = async (chunk: SpeechFlowChunk) => {
            if (typeof chunk.payload !== "string")
                throw new Error("chunk payload type must be string")
            const convertSingle = (
                start:      Duration,
                end:        Duration,
                text:       string,
                word?:      string,
                occurence?: number
            ) => {
                if (word) {
                    occurence ??= 1
                    let match = 1
                    word = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                    text = text.replaceAll(new RegExp(`\\b${word}\\b`, "g"), (m) => {
                        if (match++ === occurence)
                            return `<b>${m}</b>`
                        else
                            return m
                    })
                }
                if (this.params.format === "srt") {
                    const startFmt = start.toFormat("hh:mm:ss,SSS")
                    const endFmt   = end.toFormat("hh:mm:ss,SSS")
                    text = `${this.sequenceNo++}\n` +
                        `${startFmt} --> ${endFmt}\n` +
                        `${text}\n\n`
                }
                else if (this.params.format === "vtt") {
                    const startFmt = start.toFormat("hh:mm:ss.SSS")
                    const endFmt   = end.toFormat("hh:mm:ss.SSS")
                    text = `${startFmt} --> ${endFmt}\n` +
                        `${text}\n\n`
                }
                return text
            }
            let output = ""
            if (this.params.words) {
                output += convertSingle(chunk.timestampStart, chunk.timestampEnd, chunk.payload)
                const words = (chunk.meta.get("words") ?? []) as
                    { word: string, start: Duration, end: Duration }[]
                const occurences = new Map<string, number>()
                for (const word of words) {
                    let occurence = occurences.get(word.word) ?? 0
                    occurence++
                    occurences.set(word.word, occurence)
                    output += convertSingle(word.start, word.end, chunk.payload, word.word, occurence)
                }
            }
            else
                output += convertSingle(chunk.timestampStart, chunk.timestampEnd, chunk.payload)
            return output
        }

        /*  establish a duplex stream  */
        const self = this
        let firstChunk = true
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (firstChunk && self.params.format === "vtt") {
                    this.push(new SpeechFlowChunk(
                        Duration.fromMillis(0), Duration.fromMillis(0),
                        "final", "text",
                        "WEBVTT\n\n"
                    ))
                    firstChunk = false
                }
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    if (chunk.payload === "") {
                        this.push(chunk)
                        callback()
                    }
                    else {
                        convert(chunk).then((payload) => {
                            const chunkNew = chunk.clone()
                            chunkNew.payload = payload
                            this.push(chunkNew)
                            callback()
                        }).catch((err) => {
                            callback(err)
                        })
                    }
                }
            },
            final (callback) {
                this.push(null)
                callback()
            }
        })
    }

    /*  open node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
