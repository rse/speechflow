/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                        from "node:stream"

/*  external dependencies  */
import FFmpeg                        from "@rse/ffmpeg"
import { Converter as FFmpegStream } from "ffmpeg-stream"

/*  internal dependencies  */
import SpeechFlowNode                from "./speechflow-node"

/*  SpeechFlow node for FFmpeg  */
export default class SpeechFlowNodeFFmpeg extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "ffmpeg"

    /*  internal state  */
    private ffmpegBinary = FFmpeg.supported ? FFmpeg.binary : "ffmpeg"
    private ffmpeg: FFmpegStream | null = null

    /*  construct node  */
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            src: { type: "string", pos: 0, val: "pcm", match: /^(?:pcm|wav|mp3|opus)$/ },
            dst: { type: "string", pos: 1, val: "wav", match: /^(?:pcm|wav|mp3|opus)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination formats should not be the same")

        /*  instantiate FFmpeg sub-process  */
        this.ffmpeg = new FFmpegStream(this.ffmpegBinary)
        const streamInput = this.ffmpeg.createInputStream({
            /*  FFmpeg input options  */
            "fflags":          "nobuffer",
            "flags":           "low_delay",
            "probesize":       32,
            "analyzeduration": 0,
            ...(this.params.src === "pcm" ? {
                "f":           "s16le",
                "ar":          this.config.audioSampleRate,
                "ac":          this.config.audioChannels
            } : {}),
            ...(this.params.src === "wav" ? {
                "f":           "wav"
            } : {}),
            ...(this.params.src === "mp3" ? {
                "f":           "mp3"
            } : {}),
            ...(this.params.src === "opus" ? {
                "f":           "opus"
            } : {})
        })
        const streamOutput = this.ffmpeg.createOutputStream({
            /*  FFmpeg output options  */
            "flush_packets":   1,
            ...(this.params.dst === "pcm" ? {
                "c:a":         "pcm_s16le",
                "ar":          this.config.audioSampleRate,
                "ac":          this.config.audioChannels,
                "f":           "s16le",
            } : {}),
            ...(this.params.dst === "wav" ? {
                "f":           "wav"
            } : {}),
            ...(this.params.dst === "mp3" ? {
                "c:a":         "libmp3lame",
                "b:a":         "192k",
                "f":           "mp3"
            } : {}),
            ...(this.params.dst === "opus" ? {
                "acodec":      "libopus",
                "f":           "opus"
            } : {})
        })
        this.ffmpeg.run()

        /*  establish a duplex stream and connect it to FFmpeg  */
        this.stream = Stream.Duplex.from({
            readable: streamOutput,
            writable: streamInput
        })
    }

    /*  close node  */
    async close () {
        /*  close duplex stream  */
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

        /*  shutdown FFmpeg  */
        if (this.ffmpeg !== null) {
            this.ffmpeg.kill()
            this.ffmpeg = null
        }
    }
}

