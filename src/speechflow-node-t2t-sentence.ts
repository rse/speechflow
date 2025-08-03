/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream             from "node:stream"

/*  external dependencies  */
import { Duration }       from "luxon"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  text stream queue element */
type TextQueueElement = {
    type:         "text-frame",
    chunk:        SpeechFlowChunk,
    complete?:    boolean
} | {
    type:         "text-eof"
}

/*  SpeechFlow node for sentence splitting  */
export default class SpeechFlowNodeSentence extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "sentence"

    /*  internal state  */
    private queue      = new utils.Queue<TextQueueElement>()
    private queueRecv  = this.queue.pointerUse("recv")
    private queueSplit = this.queue.pointerUse("split")
    private queueSend  = this.queue.pointerUse("send")
    private destroyed  = false
    private workingOffTimer: ReturnType<typeof setTimeout> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({})

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.destroyed = false

        /*  work off queued audio frames  */
        let workingOff = false
        const workOffQueue = async () => {
            if (this.destroyed)
                return

            /*  control working off round  */
            if (workingOff)
                return
            workingOff = true
            if (this.workingOffTimer !== null) {
                clearTimeout(this.workingOffTimer)
                this.workingOffTimer = null
            }
            this.queue.off("write", workOffQueue)

            /*  try to work off one or more chunks  */
            while (!this.destroyed) {
                const element = this.queueSplit.peek()
                if (element === undefined)
                    break
                if (element.type === "text-eof") {
                    this.queueSplit.walk(+1)
                    break
                }
                const chunk = element.chunk
                const payload = chunk.payload as string
                const m = payload.match(/^((?:.|\r?\n)+?[.;?!])\s*((?:.|\r?\n)*)$/)
                if (m !== null) {
                    /*  contains a sentence  */
                    const [ , sentence, rest ] = m
                    if (rest !== "") {
                        /*  contains more than a sentence  */
                        const chunk2 = chunk.clone()
                        const duration = Duration.fromMillis(
                            chunk.timestampEnd.minus(chunk.timestampStart).toMillis() *
                            (sentence.length / payload.length))
                        chunk2.timestampStart = chunk.timestampStart.plus(duration)
                        chunk.timestampEnd    = chunk2.timestampStart
                        chunk.payload  = sentence
                        chunk2.payload = rest
                        element.complete = true
                        this.queueSplit.touch()
                        this.queueSplit.walk(+1)
                        this.queueSplit.insert({ type: "text-frame", chunk: chunk2 })
                    }
                    else {
                        /*  contains just the sentence  */
                        element.complete = true
                        this.queueSplit.touch()
                        this.queueSplit.walk(+1)
                    }
                }
                else {
                    /*  contains less than a sentence  */
                    const position = this.queueSplit.position()
                    if (position < this.queueSplit.maxPosition() - 1) {
                        /*  merge into following chunk  */
                        const element2 = this.queueSplit.peek(position + 1)
                        if (element2 === undefined)
                            break
                        if (element2.type === "text-eof") {
                            element.complete = true
                            this.queueSplit.touch()
                            this.queueSplit.walk(+1)
                            break
                        }
                        element2.chunk.timestampStart = element.chunk.timestampStart
                        element2.chunk.payload =
                            element.chunk.payload  as string + " " +
                            element2.chunk.payload as string
                        this.queueSplit.delete()
                        this.queueSplit.touch()
                    }
                    else
                        break
                }
            }

            /*  re-initiate working off round (if still not destroyed)  */
            workingOff = false
            if (!this.destroyed) {
                this.workingOffTimer = setTimeout(workOffQueue, 100)
                this.queue.once("write", workOffQueue)
            }
        }
        this.queue.once("write", workOffQueue)

        /*  provide Duplex stream and internally attach to classifier  */
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  receive text chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected text input as string chunks"))
                else if (chunk.payload.length === 0)
                    callback()
                else {
                    self.log("info", `received text: ${JSON.stringify(chunk.payload)}`)
                    self.queueRecv.append({ type: "text-frame", chunk })
                    callback()
                }
            },

            /*  receive no more text chunks (writable side of stream)  */
            final (callback) {
                if (self.destroyed) {
                    callback()
                    return
                }
                /*  signal end of file  */
                self.queueRecv.append({ type: "text-eof" })
                callback()
            },

            /*  send text chunk(s) (readable side of stream)  */
            read (_size) {
                /*  flush pending text chunks  */
                const flushPendingChunks = () => {
                    if (self.destroyed) {
                        this.push(null)
                        return
                    }
                    const element = self.queueSend.peek()
                    if (element !== undefined
                        && element.type === "text-eof") {
                        this.push(null)
                        self.queueSend.walk(+1)
                    }
                    else if (element !== undefined
                        && element.type === "text-frame"
                        && element.complete === true) {
                        while (true) {
                            const element = self.queueSend.peek()
                            if (element === undefined)
                                break
                            else if (element.type === "text-eof") {
                                this.push(null)
                                self.queueSend.walk(+1)
                                break
                            }
                            else if (element.type === "text-frame"
                                && element.complete !== true)
                                break
                            self.log("info", `send text: ${JSON.stringify(element.chunk.payload)}`)
                            this.push(element.chunk)
                            self.queueSend.walk(+1)
                            self.queue.trim()
                        }
                    }
                    else if (!self.destroyed)
                        self.queue.once("write", flushPendingChunks)
                }
                flushPendingChunks()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate destruction  */
        this.destroyed = true

        /*  clean up timer  */
        if (this.workingOffTimer !== null) {
            clearTimeout(this.workingOffTimer)
            this.workingOffTimer = null
        }

        /*  remove any pending event listeners  */
        this.queue.removeAllListeners("write")

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
