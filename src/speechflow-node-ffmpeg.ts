/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Stream                        from "node:stream"

import FFmpeg                        from "@rse/ffmpeg"
import { Converter as FFmpegStream } from "ffmpeg-stream"

import SpeechFlowNode                from "./speechflow-node"

export default class SpeechFlowNodeFFmpeg extends SpeechFlowNode {
    private ffmpeg: FFmpegStream | null = null

    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        this.input  = "audio"
        this.output = "audio"

        this.configure({
            src: { type: "string", pos: 0, val: "pcm", match: /^(?:pcm|mp3)$/ },
            dst: { type: "string", pos: 1, val: "mp3", match: /^(?:pcm|mp3)$/ }
        })

        if (!FFmpeg.supported)
            throw new Error("this node requires FFmpeg and this is not available on your platform")
    }

    async open () {
        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination formats cannot be the same")

        /*  instantiate FFmpeg sub-process  */
        this.ffmpeg = new FFmpegStream(FFmpeg.binary)
        const streamInput = this.ffmpeg.createInputStream({
            ...(this.params.src === "pcm" ? {
                f: "s16le",
                ar: this.config.audioSampleRate,
                ac: this.config.audioChannels,
            } : {}),
            ...(this.params.src === "mp3" ? {
                f: "mp3"
            } : {})
        })
        const streamOutput = this.ffmpeg.createOutputStream({
            ...(this.params.dst === "pcm" ? {
                f: "s16le",
                acodec: "pcm_s16le",
                ar: this.config.audioSampleRate,
                ac: this.config.audioChannels,
            } : {}),
            ...(this.params.dst === "mp3" ? {
                f: "mp3",
                acodec: "libmp3lame",
                "b:a": "192k"
            } : {})
        })
        this.ffmpeg.run()

        /*  establish a duplex stream and connect it to FFmpeg  */
        this.stream = Stream.Duplex.from({
            readable: streamOutput,
            writable: streamInput
        })
    }

    async close () {
        if (this.stream !== null) {
            await new Promise<void>((resolve) => {
                if (this.stream instanceof Stream.Duplex)
                    this.stream.end(() => { resolve() })
                else
                    resolve()
            })
            this.stream.destroy()
            this.stream = null
        }
        if (this.ffmpeg !== null) {
            this.ffmpeg.kill()
            this.ffmpeg = null
        }
    }
}

