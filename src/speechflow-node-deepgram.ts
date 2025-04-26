/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import { EventEmitter } from "node:events"
import Stream           from "node:stream"
import * as Deepgram    from "@deepgram/sdk"
import SpeechFlowNode   from "./speechflow-node"

export default class SpeechFlowNodeDevice extends SpeechFlowNode {
    private dg: Deepgram.LiveClient | null = null
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_KEY_DEEPGRAM },
            model:    { type: "string", val: "nova-2", pos: 0 }, /* FIXME: nova-3 multiligual */
            version:  { type: "string", val: "latest", pos: 1 },
            language: { type: "string", val: "de",     pos: 2 }
        })
    }
    async open () {
        this.input  = "audio"
        this.output = "text"
        this.stream = null

        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Deepgram node currently supports PCM-S16LE audio only")

        /*  connect to Deepgram API  */
        const queue = new EventEmitter()
        const deepgram = Deepgram.createClient(this.params.key)
        this.dg = deepgram.listen.live({
            model:            this.params.model,
            version:          this.params.version,
            language:         this.params.language,
            channels:         this.config.audioChannels,
            sample_rate:      this.config.audioSampleRate,
            encoding:         "linear16",
            multichannel:     false,
            // endpointing:      false,  /* FIXME: ? */
            interim_results:  false,
            smart_format:     true,
            punctuate:        true,
            filler_words:     true,
            diarize:          true,
            numerals:         true,
            paragraphs:       true,
            profanity_filter: true,
            utterances:       false,
        })
        await new Promise((resolve) => {
            this.dg!.on(Deepgram.LiveTranscriptionEvents.Open, () => {
                this.log("info", "Deepgram: connection open")
                resolve(true)
            })
        })

        /*  hooks onto Deepgram API events  */
        this.dg.on(Deepgram.LiveTranscriptionEvents.Close, () => {
            this.log("info", "Deepgram: connection close")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Transcript, async (data) => {
            const text = data.channel?.alternatives[0].transcript ?? ""
            if (text === "")
                return
            queue.emit("text", text)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Error, (error: Error) => {
            this.log("error", `Deepgram: ${error}`)
        })

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const dg = this.dg
        this.stream = new Stream.Duplex({
            write (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void) {
                const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                if (data.byteLength === 0)
                    queue.emit("text", "")
                else
                    dg.send(data)
                callback()
            },
            read (size: number) {
                queue.once("text", (text: string) => {
                    if (text !== "")
                        this.push(text)
                })
            }
        })
    }
    async close () {
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
        if (this.dg !== null)
            this.dg.requestClose()
    }
}
