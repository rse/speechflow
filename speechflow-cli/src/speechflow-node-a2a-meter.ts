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
    private silenceTimer: ReturnType<typeof setTimeout>  | null = null
    private chunkBuffer = new Float32Array(0)
    private closing = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            interval:  { type: "number", pos: 0, val: 100 },
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
        this.closing = false

        /*  internal state  */
        let lufsm = -60
        let rms   = -60

        /*  chunk processing state for LUFS-M  */
        const sampleWindowDuration = 0.4 /* LUFS-M requires 400ms */
        const sampleWindowSize = Math.floor(this.config.audioSampleRate * sampleWindowDuration)
        const sampleWindow = new Float32Array(sampleWindowSize)
        sampleWindow.fill(0, 0, sampleWindowSize)

        /*  chunk processing state for RMS  */
        const chunkDuration = 0.050 /* meter update frequency is about 50ms */
        const samplesPerChunk = Math.floor(this.config.audioSampleRate * chunkDuration)
        this.chunkBuffer = new Float32Array(0)

        /*  setup chunking interval  */
        this.calcInterval = setInterval(() => {
            /*  short-circuit during destruction  */
            if (this.closing)
                return

            /*  short-circuit if still not enough chunk data  */
            if (this.chunkBuffer.length < samplesPerChunk)
                return

            /*  grab the accumulated chunk data  */
            const chunkData = this.chunkBuffer
            this.chunkBuffer = new Float32Array(0)

            /*  update internal audio sample sliding window for LUFS-S  */
            if (chunkData.length > sampleWindow.length)
                sampleWindow.set(chunkData.subarray(chunkData.length - sampleWindow.length), 0)
            else {
                sampleWindow.set(sampleWindow.subarray(chunkData.length), 0)
                sampleWindow.set(chunkData, sampleWindow.length - chunkData.length)
            }

            /*  calculate the LUFS-M metric  */
            const audioDataLUFS = {
                sampleRate:       this.config.audioSampleRate,
                numberOfChannels: this.config.audioChannels,
                channelData:      [ sampleWindow ],
                duration:         sampleWindowDuration,
                length:           sampleWindow.length
            } satisfies AudioData
            const lufs = getLUFS(audioDataLUFS, {
                channelMode: this.config.audioChannels === 1 ? "mono" : "stereo",
                calculateShortTerm:     false,
                calculateMomentary:     true,
                calculateLoudnessRange: false,
                calculateTruePeak:      false
            })
            lufsm = lufs.momentary ? Math.max(-60, lufs.momentary[0]) : -60

            /*  calculate the RMS metric  */
            const totalSamples   = chunkData.length / this.config.audioChannels
            const duration       = totalSamples / this.config.audioSampleRate
            const audioDataRMS = {
                sampleRate:       this.config.audioSampleRate,
                numberOfChannels: this.config.audioChannels,
                channelData:      [ chunkData ],
                duration,
                length:           chunkData.length
            } satisfies AudioData
            rms = Math.max(-60, getRMS(audioDataRMS, {
                asDB: true
            }))

            /*  automatically clear measurement (in case no new measurements happen)  */
            if (this.silenceTimer !== null)
                clearTimeout(this.silenceTimer)
            this.silenceTimer = setTimeout(() => {
                lufsm = -60
                rms   = -60
            }, 500)
        }, chunkDuration * 1000)

        /*  setup loudness emitting interval  */
        this.emitInterval = setInterval(() => {
            if (this.closing)
                return
            this.log("debug", `LUFS-M: ${lufsm.toFixed(1)} dB, RMS: ${rms.toFixed(1)} dB`)
            this.sendResponse([ "meter", "LUFS-M", lufsm ])
            this.sendResponse([ "meter", "RMS", rms ])
            if (this.params.dashboard !== "")
                this.sendDashboard("audio", this.params.dashboard, "final", lufsm)
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
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("expected audio input as Buffer chunks"))
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
                        if (self.params.mode === "filter")
                            this.push(chunk)
                        callback()
                    }
                    catch (error) {
                        callback(util.ensureError(error, "meter processing failed"))
                    }
                }
            },
            final (callback) {
                if (self.closing || self.params.mode === "sink") {
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
        /*  indicate closing immediately to stop any ongoing operations  */
        this.closing = true

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

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}