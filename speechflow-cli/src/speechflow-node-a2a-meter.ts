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
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for audio metering  */
export default class SpeechFlowNodeA2AMeter extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-meter"

    /*  internal state  */
    private emitInterval: ReturnType<typeof setInterval> | null = null
    private calcInterval: ReturnType<typeof setInterval> | null = null
    private silenceTimer: ReturnType<typeof setTimeout> | null = null
    private chunkBuffer = new Float32Array(0)
    private destroyed = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            interval:  { type: "number", pos: 0, val: 250 },
            mode:      { type: "string", pos: 1, val: "filter", match: /^(?:filter|sink)$/ },
            dashboard: { type: "string",         val: "" }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        if (this.params.mode === "filter")
            this.output = "audio"
        else if (this.params.mode === "sink")
            this.output = "none"
    }

    /*  open node  */
    async open () {
        /*  sanity check situation  */
        if (this.config.audioBitDepth !== 16 || !this.config.audioLittleEndian)
            throw new Error("meter node currently supports PCM-S16LE audio only")

        /*  clear destruction flag  */
        this.destroyed = false

        /*  internal state  */
        const sampleWindowDuration = 3 /* LUFS-S requires 3s */
        const sampleWindowSize = Math.floor(this.config.audioSampleRate * sampleWindowDuration)
        let sampleWindow = new Float32Array(sampleWindowSize)
        sampleWindow.fill(0, 0, sampleWindowSize)
        let lufss = -60
        let rms   = -60

        /*  chunk processing state  */
        const chunkDuration = 0.050 /* meter update frequency is about 50ms */
        const samplesPerChunk = Math.floor(this.config.audioSampleRate * chunkDuration)
        this.chunkBuffer = new Float32Array(0)

        /*  define chunk processing function  */
        const processChunk = (chunkData: Float32Array) => {
            /*  update internal audio sample sliding window  */
            const newWindow = new Float32Array(sampleWindowSize)
            newWindow.set(sampleWindow.slice(chunkData.length), 0)
            newWindow.set(chunkData, sampleWindowSize - chunkData.length)
            sampleWindow = newWindow

            /*  calculate the LUFS-S and RMS metric  */
            const audioData = {
                sampleRate:       this.config.audioSampleRate,
                numberOfChannels: this.config.audioChannels,
                channelData:      [ sampleWindow ],
                duration:         sampleWindowDuration,
                length:           sampleWindow.length
            } satisfies AudioData
            const lufs = getLUFS(audioData, {
                channelMode: this.config.audioChannels === 1 ? "mono" : "stereo",
                calculateShortTerm:     true,
                calculateMomentary:     false,
                calculateLoudnessRange: false,
                calculateTruePeak:      false
            })
            lufss = lufs.shortTerm ? lufs.shortTerm[0] : -60
            rms = getRMS(audioData, { asDB: true })
            if (this.silenceTimer !== null)
                clearTimeout(this.silenceTimer)
            this.silenceTimer = setTimeout(() => {
                lufss = -60
                rms   = -60
            }, 500)
        }

        /*  setup chunking interval  */
        this.calcInterval = setInterval(() => {
            if (this.destroyed)
                return

            /*  process one single 50ms chunk if available  */
            if (this.chunkBuffer.length >= samplesPerChunk) {
                const chunkData = this.chunkBuffer.slice(0, samplesPerChunk)
                this.chunkBuffer = this.chunkBuffer.slice(samplesPerChunk)
                processChunk(chunkData)
            }
        }, chunkDuration * 1000)

        /*  setup loudness emitting interval  */
        this.emitInterval = setInterval(() => {
            if (this.destroyed)
                return
            this.log("debug", `LUFS-S: ${lufss.toFixed(1)} dB, RMS: ${rms.toFixed(1)} dB`)
            this.sendResponse([ "meter", "LUFS-S", lufss ])
            this.sendResponse([ "meter", "RMS", rms ])
            if (this.params.dashboard !== "")
                this.sendDashboard("audio", this.params.dashboard, "final", lufss)
        }, this.params.interval)

        /*  provide Duplex stream and internally attach to meter  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,

            /*  transform audio chunk  */
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.destroyed) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
                else if (self.params.mode === "sink")
                    callback()
                else if (chunk.payload.byteLength === 0)
                    callback()
                else {
                    try {
                        /*  convert audio samples from PCM/I16 to PCM/F32  */
                        const data = util.convertBufToF32(chunk.payload, self.config.audioLittleEndian)

                        /*  append new data to buffer  */
                        const combinedLength = self.chunkBuffer.length + data.length
                        const newBuffer = new Float32Array(combinedLength)
                        newBuffer.set(self.chunkBuffer, 0)
                        newBuffer.set(data, self.chunkBuffer.length)
                        self.chunkBuffer = newBuffer

                        /*  pass-through original audio chunk  */
                        this.push(chunk)
                        callback()
                    }
                    catch (error) {
                        callback(error instanceof Error ? error : new Error("meter processing failed"))
                    }
                }
            },
            final (callback) {
                if (self.destroyed || self.params.mode === "sink") {
                    callback()
                    return
                }
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  stop intervals  */
        if (this.emitInterval !== null) {
            clearInterval(this.emitInterval)
            this.emitInterval = null
        }
        if (this.calcInterval !== null) {
            clearInterval(this.calcInterval)
            this.calcInterval = null
        }
        if (this.silenceTimer !== null) {
            clearTimeout(this.silenceTimer)
            this.silenceTimer = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  indicate destruction  */
        this.destroyed = true
    }
}