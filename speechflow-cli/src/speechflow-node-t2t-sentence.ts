/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
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
    private lastChunkTime = 0

    /*  known abbreviations from English and German (lowercased),
        which should NOT be treated as sentence boundaries  */
    private static abbreviations = new Set([
        "prof", "dr", "mr", "mrs", "ms", "jr", "sr", "st",
        "vs", "etc", "ca", "bzw", "bspw", "usw", "sog", "ggf", "evtl"
    ])

    /*  find the first valid sentence boundary in text  */
    private static findSentenceBoundary (text: string): { sentence: string, rest: string } | null {
        for (let i = 0; i < text.length; i++) {
            /*  match sentence-ending punctuation (including ellipsis "..." and "…")  */
            const pm = /^(\.\.\.|\u2026|\.|\?|!)/.exec(text.slice(i, i + 3))
            if (!pm)
                continue
            const firstPunctPos = i
            i += pm[1].length - 1

            /*  extract the word preceding the punctuation mark  */
            let j = Math.max(0, firstPunctPos - 1)
            while (j >= 0) {
                /*  handle surrogate pairs (for characters outside the BMP)  */
                if (j > 0 && /[\uDC00-\uDFFF]/.test(text[j])) {
                    if (!/^\p{L}$/u.test(text[j - 1] + text[j]))
                        break
                    j -= 2
                }
                else {
                    if (!/^\p{L}$/u.test(text[j]))
                        break
                    j--
                }
            }
            const precedingWord = text.substring(j + 1, firstPunctPos)

            /*  skip abbreviations (only relevant for periods)  */
            if (pm[1] === ".") {
                /*  skip single-letter abbreviations (handles "U.S.", "e.g.", "i.e.", etc.)  */
                if (precedingWord.length === 1 && /^\p{L}$/u.test(precedingWord))
                    continue

                /*  skip known multi-letter abbreviations (case-insensitive matching)  */
                if (SpeechFlowNodeT2TSentence.abbreviations.has(precedingWord.toLowerCase()))
                    continue
            }

            /*  return what follows the punctuation mark
                (also skip over optional closing quotes/parentheses/brackets)  */
            const after = text.substring(i + 1)
            const m = after.match(/^(["\u201D\u2019)\]]*)\s+([\s\S]+)$/)
            if (m !== null)
                return { sentence: text.substring(0, i + 1 + m[1].length), rest: m[2] }

            /*  found a punctuation at end of text (possibly with trailing closing chars and whitespace)  */
            if (/^["\u201D\u2019)\]]*\s*$/.test(after))
                return { sentence: text.substring(0, i + 1) + after.replace(/\s+$/, ""), rest: "" }
        }
        return null
    }

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
        if (!(/\s+$/.test(s1) || /^\s+/.test(s2)))
            return `${s1} ${s2}`
        else
            return `${s1}${s2}`
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  work off queued text frames (inner processing)  */
        const workOffQueueInner = (): boolean => {
            const maxIterations = 50
            let iterations = 0
            while (!this.closing && iterations < maxIterations) {
                iterations++
                const element = this.queueSplit.peek()
                if (element === undefined)
                    break
                if (element.type === "text-eof") {
                    this.queueSplit.walk(+1)
                    break
                }

                /*  skip elements already completed  */
                if (element.type === "text-frame"
                    && element.chunk.kind === "final"
                    && element.complete === true) {
                    this.queueSplit.walk(+1)
                    continue
                }

                /*  perform sentence splitting on input chunk  */
                if (element.chunk.kind === "final") {
                    element.chunk = element.chunk.clone()
                    const chunk = element.chunk
                    const payload = chunk.payload as string
                    const boundary = SpeechFlowNodeT2TSentence.findSentenceBoundary(payload)
                    if (boundary !== null) {
                        /*  contains a sentence  */
                        const { sentence, rest } = boundary
                        if (rest !== "") {
                            /*  contains more than a sentence  */
                            const chunk2 = chunk.clone()
                            const duration = Duration.fromMillis(
                                chunk.timestampEnd.minus(chunk.timestampStart).toMillis() *
                                (sentence.length / Math.max(payload.length, 1)))
                            chunk2.timestampStart = chunk.timestampStart.plus(duration)
                            chunk.timestampEnd    = chunk2.timestampStart
                            chunk.payload  = sentence
                            chunk2.payload = rest
                            element.complete = true
                            this.queue.silently(() => { this.queueSplit.touch() })
                            this.queueSplit.walk(+1)
                            this.queueSplit.insert({ type: "text-frame", chunk: chunk2, complete: false })
                        }
                        else {
                            /*  contains just the sentence  */
                            element.complete = true
                            const position = this.queue.silently(() =>
                                this.queueSplit.silently(() => {
                                    const pos = this.queueSplit.position()
                                    this.queueSplit.walk(+1)
                                    return pos
                                })
                            )
                            if (position < this.queue.elements.length)
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
                                element2.chunk = element2.chunk.clone()
                                element2.chunk.timestampStart = element.chunk.timestampStart
                                element2.chunk.payload = this.concatPayload(element.chunk.payload as string,
                                    element2.chunk.payload as string)

                                /*  remove current element and touch now current element  */
                                this.queue.silently(() => { this.queueSplit.delete() })
                                this.queueSplit.touch()
                            }
                            else
                                break
                        }
                        else if (this.lastChunkTime > 0
                            && (Date.now() - this.lastChunkTime) >= (this.params.timeout as number)) {
                            /*  no following chunk yet, but timeout expired:
                                flush incomplete sentence fragment  */
                            element.complete = true
                            const position = this.queue.silently(() =>
                                this.queueSplit.silently(() => {
                                    const pos = this.queueSplit.position()
                                    this.queueSplit.walk(+1)
                                    return pos
                                })
                            )
                            if (position < this.queue.elements.length)
                                this.queueSplit.touch(position)
                        }
                        else {
                            /*  no following chunk yet, still within timeout  */
                            break
                        }
                    }
                }
                else
                    break
            }
            return (!this.closing && iterations >= maxIterations)
        }

        /*  work off queued text frames (outer processing)  */
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
            let hasMore = false
            try {
                hasMore = workOffQueueInner()
            }
            catch (error) {
                this.log("error", `sentence splitting error: ${error}`)
            }
            finally {
                /*  re-initiate working off round (if still not destroyed)  */
                workingOff = false
                if (!this.closing) {
                    this.workingOffTimer = setTimeout(workOffQueue, hasMore ? 0 : 100)
                    this.queue.once("write", workOffQueue)
                }
            }
        }
        this.queue.once("write", workOffQueue)

        /*  provide Duplex stream and internally attach to classifier  */
        let previewedPayload = ""
        let flushListenerRegistered = false
        let eofPushed = false
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
                    previewedPayload = ""
                    self.queueRecv.append({ type: "text-frame", chunk, complete: false })
                    self.lastChunkTime = Date.now()
                    callback()
                }
            },

            /*  receive no more text chunks (writable side of stream)  */
            final (callback: (error?: Error | null) => void) {
                if (self.closing) {
                    callback()
                    return
                }

                /*  promote any trailing intermediate chunk to final
                    (no replacement will ever arrive, so treat it as final)  */
                const recvPos = self.queueRecv.position()
                if (recvPos > 0) {
                    const element = self.queueRecv.peek(recvPos - 1)
                    if (element
                        && element.type === "text-frame"
                        && element.chunk.kind === "intermediate") {
                        element.chunk = element.chunk.clone()
                        element.chunk.kind = "final"
                    }
                }

                /*  signal end of file  */
                self.queueRecv.append({ type: "text-eof" })
                callback()
            },

            /*  send text chunk(s) (readable side of stream)  */
            read (_size) {
                /*  idempotently push EOF to readable side  */
                const pushNull = () => {
                    if (eofPushed)
                        return
                    eofPushed = true
                    this.push(null)
                }

                /*  flush pending text chunks  */
                const flushPendingChunks = () => {
                    flushListenerRegistered = false
                    if (self.closing) {
                        pushNull()
                        return
                    }
                    const element = self.queueSend.peek()
                    if (element !== undefined
                        && element.type === "text-eof") {
                        pushNull()
                        self.queueSend.walk(+1)
                        self.queue.trim()
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
                                pushNull()
                                self.queueSend.walk(+1)
                                eofSeen = true
                                break
                            }
                            else if (nextElement.type === "text-frame"
                                && nextElement.complete !== true)
                                break
                            self.log("info", `send text/complete (${nextElement.chunk.kind}): ${JSON.stringify(nextElement.chunk.payload)} pos=${self.queueSend.position()}`)
                            this.push(nextElement.chunk)
                            self.queueSend.walk(+1)
                        }
                        previewedPayload = ""
                        self.queue.trim()

                        /*  wait for more data (unless end-of-stream was reached)  */
                        if (!eofSeen && !self.closing && !flushListenerRegistered) {
                            flushListenerRegistered = true
                            self.queue.once("write", flushPendingChunks)
                        }
                    }
                    else if (element !== undefined
                        && element.type === "text-frame"
                        && element.complete === false
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
                            previewChunk.timestampEnd = element2.chunk.timestampEnd
                        }

                        /*  send preview only if payload actually changed  */
                        if ((previewChunk.payload as string) !== previewedPayload) {
                            this.push(previewChunk)
                            self.log("info", `send text/preview (intermediate): ${JSON.stringify(previewChunk.payload)}`)
                            previewedPayload = previewChunk.payload as string
                        }

                        /*  wait for more data  */
                        if (!self.closing && !flushListenerRegistered) {
                            flushListenerRegistered = true
                            self.queue.once("write", flushPendingChunks)
                        }
                    }
                    else if (!self.closing && !flushListenerRegistered) {
                        flushListenerRegistered = true
                        self.queue.once("write", flushPendingChunks)
                    }
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

        /*  remove any pending event listeners and clear queue  */
        this.queue.removeAllListeners("write")
        this.queue.clear()

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
