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
import * as util                           from "./speechflow-util"

/*  text stream queue element  */
type TextQueueElement = {
    type:      "text-frame",
    chunk:     SpeechFlowChunk,
    preview?:  "pending" | "sent",
    complete?: boolean
} | {
    type:      "text-eof"
}

/*  SpeechFlow node for sentence splitting  */
export default class SpeechFlowNodeT2TSentence extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-sentence"

    /*  internal state  */
    private queue      = new util.Queue<TextQueueElement>()
    private queueRecv  = this.queue.pointerUse("recv")
    private queueSplit = this.queue.pointerUse("split")
    private queueSend  = this.queue.pointerUse("send")
    private closing  = false
    private workingOffTimer: ReturnType<typeof setTimeout> | null = null
    private previewTimer:    ReturnType<typeof setTimeout> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            timeout: { type: "number",  pos: 0, val: 3 * 1000 },
            interim: { type: "boolean", pos: 1, val: false    }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  work off queued text frames  */
        let workingOff = false
        const workOffQueue = async () => {
            if (this.closing)
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
            while (!this.closing) {
                const element = this.queueSplit.peek()
                if (element === undefined)
                    break
                if (element.type === "text-eof") {
                    this.queueSplit.walk(+1)
                    break
                }

                /*  skip elements already completed (e.g. by preview timeout)  */
                if (element.type === "text-frame" && element.complete === true) {
                    this.queueSplit.walk(+1)
                    continue
                }

                /*  perform sentence splitting on input chunk  */
                const chunk = element.chunk
                const payload = chunk.payload as string
                const m = payload.match(/^((?:.|\r?\n)+?[.;?!])(?:\s+((?:.|\r?\n)*))?$/)
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
                            /*  no more chunks: output as final
                                (perhaps incomplete sentence at end of stream)  */
                            element.complete = true
                            this.queueSplit.touch()
                            this.queueSplit.walk(+1)
                            break
                        }

                        /*  merge into following chunk  */
                        element2.chunk.timestampStart = element.chunk.timestampStart
                        element2.chunk.payload =
                            (element.chunk.payload  as string) + " " +
                            (element2.chunk.payload as string)

                        /*  reset preview state (merged content needs new preview)  */
                        element2.preview = undefined
                        this.queueSplit.delete()
                        this.queueSplit.touch()
                    }
                    else {
                        /*  no following chunk yet: mark for intermediate preview output  */
                        if (element.preview !== "sent") {
                            element.preview = "pending"
                            this.queueSplit.touch()
                        }
                        break
                    }
                }
            }

            /*  re-initiate working off round (if still not destroyed)  */
            workingOff = false
            if (!this.closing) {
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
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected text input as string chunks"))
                else if (chunk.payload.length === 0)
                    callback()
                else if (chunk.kind === "intermediate") {
                    /*  intermediate chunks: pass through immediately (bypass queue)  */
                    self.log("info", `received text (${chunk.kind}): ${JSON.stringify(chunk.payload)}`)
                    self.log("info", `send text (intermediate pass-through): ${JSON.stringify(chunk.payload)}`)
                    this.push(chunk)
                    callback()
                }
                else {
                    /*  final chunks: queue for sentence splitting  */
                    self.log("info", `received text (${chunk.kind}): ${JSON.stringify(chunk.payload)}`)

                    /*  cancel any pending preview timeout  */
                    if (self.previewTimer !== null) {
                        clearTimeout(self.previewTimer)
                        self.previewTimer = null
                    }

                    self.queueRecv.append({ type: "text-frame", chunk })
                    callback()
                }
            },

            /*  receive no more text chunks (writable side of stream)  */
            final (callback) {
                if (self.closing) {
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
                    if (self.closing) {
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
                        /*  send all consecutive complete chunks  */
                        let eofSeen = false
                        while (true) {
                            const nextElement = self.queueSend.peek()
                            if (nextElement === undefined)
                                break
                            else if (nextElement.type === "text-eof") {
                                this.push(null)
                                self.queueSend.walk(+1)
                                eofSeen = true
                                break
                            }
                            else if (nextElement.type === "text-frame"
                                && nextElement.complete !== true)
                                break
                            self.log("info", `send text (${nextElement.chunk.kind}): ${JSON.stringify(nextElement.chunk.payload)}`)
                            this.push(nextElement.chunk)
                            self.queueSend.walk(+1)
                            self.queue.trim()
                        }

                        /*  wait for more data (unless end-of-stream was reached)  */
                        if (!eofSeen && !self.closing)
                            self.queue.once("write", flushPendingChunks)
                    }
                    else if (element !== undefined
                        && element.type === "text-frame"
                        && element.preview === "pending"
                        && self.params.interim === true) {
                        /*  send intermediate preview (without advancing pointer)  */
                        const previewChunk = element.chunk.clone()
                        previewChunk.kind = "intermediate"
                        self.log("info", `send text (intermediate preview): ${JSON.stringify(previewChunk.payload)}`)
                        this.push(previewChunk)
                        element.preview = "sent"
                        self.queueSend.touch()

                        /*  start preview timeout (if configured)  */
                        const timeout = self.params.timeout as number
                        if (timeout > 0 && self.previewTimer === null) {
                            self.previewTimer = setTimeout(() => {
                                self.previewTimer = null
                                if (self.closing)
                                    return

                                /*  promote preview to final chunk  */
                                const el = self.queueSend.peek()
                                if (el !== undefined
                                    && el.type === "text-frame"
                                    && el.preview === "sent"
                                    && el.complete !== true) {
                                    self.log("info", `timeout: promoting intermediate to final: ${JSON.stringify(el.chunk.payload)}`)
                                    el.complete = true
                                    self.queueSend.touch()
                                    self.queue.emit("write")
                                }
                            }, timeout)
                        }

                        /*  wait for more data  */
                        if (!self.closing)
                            self.queue.once("write", flushPendingChunks)
                    }
                    else if (!self.closing)
                        self.queue.once("write", flushPendingChunks)
                }
                flushPendingChunks()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  clean up timers  */
        if (this.workingOffTimer !== null) {
            clearTimeout(this.workingOffTimer)
            this.workingOffTimer = null
        }
        if (this.previewTimer !== null) {
            clearTimeout(this.previewTimer)
            this.previewTimer = null
        }

        /*  remove any pending event listeners  */
        this.queue.removeAllListeners("write")

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
