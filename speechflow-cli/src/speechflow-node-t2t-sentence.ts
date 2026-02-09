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
    complete:  boolean
} | {
    type:      "text-eof"
}

/*  SpeechFlow node for sentence splitting  */
export default class SpeechFlowNodeT2TSentence extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-sentence"

    /*  internal state  */
    private queue      = new util.Queue<TextQueueElement>()
    private queueSend  = this.queue.pointerUse("send")
    private queueSplit = this.queue.pointerUse("split")
    private queueRecv  = this.queue.pointerUse("recv")
    private closing    = false
    private workingOffTimer: ReturnType<typeof setTimeout> | null = null

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

    /*  concatenate two payloads with proper whitespacing  */
    private concatPayload (s1: string, s2: string) {
        if (!(s1.match(/\s+$/) || s2.match(/^\s+/)))
            return `${s1} ${s2}`
        else
            return `${s1}${s2}`
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

                /*  skip elements already completed  */
                if (element.type === "text-frame" && element.chunk.kind === "final" && element.complete === true) {
                    this.queueSplit.walk(+1)
                    continue
                }

                /*  perform sentence splitting on input chunk  */
                if (element.chunk.kind === "final") {
                    const chunk = element.chunk
                    const payload = chunk.payload as string
                    const m = payload.match(/^((?:.|\r?\n)+?[.;?!])(?:\s+((?:.|\r?\n)+)|\s*)$/)
                    if (m !== null) {
                        /*  contains a sentence  */
                        const [ , sentence, rest ] = m
                        if (rest !== undefined && rest !== "") {
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
                            this.queue.silent(true)
                            this.queueSplit.touch()
                            this.queue.silent(false)
                            this.queueSplit.walk(+1)
                            this.queueSplit.insert({ type: "text-frame", chunk: chunk2, complete: false })
                        }
                        else {
                            /*  contains just the sentence  */
                            element.complete = true
                            this.queue.silent(true)
                            this.queueSplit.silent(true)
                            const position = this.queueSplit.position()
                            this.queueSplit.walk(+1)
                            this.queue.silent(false)
                            this.queueSplit.silent(false)
                            this.queueSplit.touch(position)
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
                                this.queueSplit.walk(+1)
                                this.queueSplit.touch(this.queueSplit.position() - 1)
                                break
                            }
                            if (element2.chunk.kind === "final") {
                                /*  merge into following chunk  */
                                element2.chunk.timestampStart = element.chunk.timestampStart
                                element2.chunk.payload = this.concatPayload(element.chunk.payload as string,
                                    element2.chunk.payload as string)

                                /*  remove current element and touch now current element  */
                                this.queue.silent(true)
                                this.queueSplit.delete()
                                this.queue.silent(false)
                                this.queueSplit.touch()
                            }
                            else
                                break
                        }
                        else {
                            /*  no following chunk yet  */
                            break
                        }
                    }
                }
                else
                    break
            }

            /*  re-initiate working off round (if still not destroyed)  */
            if (!this.closing) {
                this.workingOffTimer = setTimeout(workOffQueue, 100)
                this.queue.once("write", workOffQueue)
            }
            workingOff = false
        }
        this.queue.once("write", workOffQueue)

        /*  provide Duplex stream and internally attach to classifier  */
        let previewed = false
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  receive text chunk (writable side of stream)  */
            write (chunk: SpeechFlowChunk, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected text input as string chunks"))
                else if (chunk.payload.length === 0)
                    callback()
                else {
                    /*  final chunks: queue for sentence splitting  */
                    self.log("info", `received text (${chunk.kind}): ${JSON.stringify(chunk.payload)}`)
                    const recvPos = self.queueRecv.position()
                    if (recvPos > 0) {
                        const element = self.queueRecv.peek(recvPos - 1)
                        if (element) {
                            if (element.type === "text-eof") {
                                callback(new Error("received text input after end-of-stream"))
                                return
                            }
                            if (element.chunk.kind === "intermediate") {
                                self.queueRecv.walk(-1)
                                self.queueRecv.delete()
                            }
                        }
                    }
                    previewed = false
                    self.queueRecv.append({ type: "text-frame", chunk, complete: false })
                    callback()
                }
            },

            /*  receive no more text chunks (writable side of stream)  */
            final (callback: (error?: Error | null) => void) {
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
                            self.log("info", `send text 1 (${nextElement.chunk.kind}): ${JSON.stringify(nextElement.chunk.payload)} pos=${self.queueSend.position()}`)
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
                        && element.complete === false
                        && !previewed
                        && self.params.interim === true) {
                        /*  merge together all still queued elements and
                            send this out as an intermediate chunk as preview  */
                        const previewChunk = element.chunk.clone()
                        previewChunk.kind = "intermediate"
                        for (let pos = self.queueSend.position() + 1; pos < self.queueSend.maxPosition(); pos++) {
                            const element2 = self.queueSend.peek(pos)
                            if (!element2)
                                continue
                            if (element2.type === "text-eof")
                                break
                            previewChunk.payload = self.concatPayload(
                                previewChunk.payload as string, element2.chunk.payload as string)
                        }
                        this.push(previewChunk)
                        self.log("info", `send text 2 (intermediate): ${JSON.stringify(previewChunk.payload)}`)
                        previewed = true

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

        /*  remove any pending event listeners  */
        this.queue.removeAllListeners("write")

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
