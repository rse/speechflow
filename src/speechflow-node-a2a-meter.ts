/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { getLUFS, getRMS, AudioData } from "audio-inspect"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for audio metering  */
export default class SpeechFlowNodeMeter extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "meter"

    /*  internal state  */
    interval: ReturnType<typeof setInterval> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            interval: { type: "number", pos: 0, val: 250 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("meter node currently supports PCM-S16LE audio only")

        /*  internal state  */
        const sampleWindowDuration = 3 /* LUFS-S requires 3s */
        const sampleWindowSize = this.config.audioSampleRate * sampleWindowDuration
        let sampleWindow = new Float32Array(sampleWindowSize)
        sampleWindow.fill(0, 0, sampleWindowSize)
        let lufss = 0
        let rms = 0

        /*  setup loudness emitting interval  */
        this.interval = setInterval(() => {
            this.log("info", `LUFS-S: ${lufss.toFixed(1)} dB, RMS: ${rms.toFixed(1)} dB`)
            this.sendResponse([ "meter", "LUFS-S", lufss ])
            this.sendResponse([ "meter", "RMS", rms ])
        }, this.params.interval)

        /*  provide Duplex stream and internally attach to VAD  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  transform audio chunk  */
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    /*  convert audio samples from PCM/I16 to PCM/F32  */
                    const data = utils.convertBufToF32(chunk.payload, self.config.audioLittleEndian)

                    /*  update internal audio sample sliding window  */
                    const fusion = new Float32Array(sampleWindow.length + data.length)
                    fusion.set(sampleWindow, 0)
                    fusion.set(data, sampleWindow.length)
                    sampleWindow = fusion.slice(fusion.length - sampleWindowSize)

                    /*  asynchronously calculate the LUFS-S metric  */
                    setTimeout(() => {
                        const audioData = {
                            sampleRate:       self.config.audioSampleRate,
                            numberOfChannels: self.config.audioChannels,
                            channelData:      [ sampleWindow ],
                            duration:         sampleWindowDuration,
                            length:           sampleWindow.length
                        } satisfies AudioData
                        const lufs = getLUFS(audioData, {
                            channelMode: self.config.audioChannels === 1 ? "mono" : "stereo",
                            calculateShortTerm:     true,
                            calculateMomentary:     false,
                            calculateLoudnessRange: false,
                            calculateTruePeak:      false
                        })
                        lufss = lufs.shortTerm ? lufs.shortTerm[0] : 0
                        rms = getRMS(audioData, { asDB: true })
                    }, 0)

                    /*  pass-through original audio chunk  */
                    this.push(chunk)
                    callback()
                }
            },
            final (callback) {
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

        /*  stop interval  */
        if (this.interval !== null) {
            clearInterval(this.interval)
            this.interval = null
        }
    }
}
