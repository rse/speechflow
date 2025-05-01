/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import { EventEmitter } from "node:events"
import Stream           from "node:stream"

/*  external dependencies  */
import * as Deepgram    from "@deepgram/sdk"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"

/*  SpeechFlow node for Deepgram speech-to-text conversion  */
export default class SpeechFlowNodeDeepgram extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "deepgram"

    /*  internal state  */
    private dg: Deepgram.LiveClient | null = null

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string", val: process.env.SPEECHFLOW_KEY_DEEPGRAM },
            model:    { type: "string", val: "nova-3", pos: 0 },
            version:  { type: "string", val: "latest", pos: 1 },
            language: { type: "string", val: "multi",  pos: 2 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("Deepgram node currently supports PCM-S16LE audio only")

        /*  create queue for results  */
        const queue = new EventEmitter()

        /*  connect to Deepgram API  */
        const deepgram = Deepgram.createClient(this.params.key)
        this.dg = deepgram.listen.live({
            model:            this.params.model,
            version:          this.params.version,
            language:         this.params.language,
            channels:         this.config.audioChannels,
            sample_rate:      this.config.audioSampleRate,
            encoding:         "linear16",
            multichannel:     false,
            endpointing:      10,
            interim_results:  false,
            smart_format:     true,
            punctuate:        true,
            filler_words:     true,
            diarize:          true,
            numerals:         true,
            paragraphs:       true,
            profanity_filter: true,
            utterances:       false
        })

        /*  hook onto Deepgram API events  */
        this.dg.on(Deepgram.LiveTranscriptionEvents.Transcript, async (data) => {
            this.log("info", `Deepgram: text received (start: ${data.start}s, duration: ${data.duration}s)`)
            const text = (data.channel?.alternatives[0].transcript as string) ?? ""
            queue.emit("text", text)
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Metadata, (data) => {
            this.log("info", "Deepgram: metadata received")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Close, () => {
            this.log("info", "Deepgram: connection close")
        })
        this.dg.on(Deepgram.LiveTranscriptionEvents.Error, (error: Error) => {
            this.log("error", `Deepgram: ${error.message}`)
            this.emit("error")
        })

        /*  wait for Deepgram API to be available  */
        await new Promise((resolve) => {
            this.dg!.once(Deepgram.LiveTranscriptionEvents.Open, () => {
                this.log("info", "Deepgram: connection open")
                resolve(true)
            })
        })

        /*  provide Duplex stream and internally attach to Deepgram API  */
        const dg = this.dg
        const log = (level: string, msg: string) => {
            this.log(level, msg)
        }
        const encoding = this.config.textEncoding
        this.stream = new Stream.Duplex({
            writableObjectMode: false,
            readableObjectMode: true,
            decodeStrings:      false,
            write (chunk: Buffer, encoding, callback) {
                if (!Buffer.isBuffer(chunk))
                    callback(new Error("expected audio input as Buffer chunks"))
                else {
                    const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                    if (data.byteLength === 0)
                        queue.emit("text", "")
                    else {
                        log("info", `Deepgram: send data (${data.byteLength} bytes)`)
                        dg.send(chunk)
                    }
                    callback()
                }
            },
            read (size) {
                queue.once("text", (text: string) => {
                    log("info", `Deepgram: receive data (${text.length} bytes)`)
                    this.push(text, encoding)
                })
            },
            final (callback) {
                dg.requestClose()
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

        /*  shutdown Deepgram API  */
        if (this.dg !== null)
            this.dg.requestClose()
    }
}
