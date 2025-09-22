/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  write WAV header  */
const writeWavHeader = (
    length: number,
    options?: { audioFormat?: number, channels?: number, sampleRate?: number, bitDepth?: number }
) => {
    const audioFormat  = options?.audioFormat ?? 0x001 /* PCM */
    const channels     = options?.channels    ?? 1     /* mono */
    const sampleRate   = options?.sampleRate  ?? 44100 /* 44KHz */
    const bitDepth     = options?.bitDepth    ?? 16    /* 16-Bit */

    const headerLength = 44
    const maxDataSize  = Math.pow(2, 32) - 100 /* safe maximum for 32-bit WAV files */
    const dataLength   = length ?? maxDataSize
    const fileSize     = dataLength + headerLength
    const header       = Buffer.alloc(headerLength)

    const byteRate     = (sampleRate * channels * bitDepth) / 8
    const blockAlign   = (channels * bitDepth) / 8

    let offset = 0
    header.write("RIFF", offset);               offset += 4
    header.writeUInt32LE(fileSize - 8, offset); offset += 4
    header.write("WAVE", offset);               offset += 4
    header.write("fmt ", offset);               offset += 4
    header.writeUInt32LE(16, offset);           offset += 4
    header.writeUInt16LE(audioFormat, offset);  offset += 2
    header.writeUInt16LE(channels, offset);     offset += 2
    header.writeUInt32LE(sampleRate, offset);   offset += 4
    header.writeUInt32LE(byteRate, offset);     offset += 4
    header.writeUInt16LE(blockAlign, offset);   offset += 2
    header.writeUInt16LE(bitDepth, offset);     offset += 2
    header.write("data", offset);               offset += 4
    header.writeUInt32LE(dataLength, offset);   offset += 4

    return header
}

/*  read WAV header  */
const readWavHeader = (buffer: Buffer) => {
    if (buffer.length < 44)
        throw new Error("WAV header too short, expected at least 44 bytes")

    let offset = 0
    const riffHead     = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const fileSize     = buffer.readUInt32LE(offset);                    offset += 4
    const waveHead     = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const fmtHead      = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const formatLength = buffer.readUInt32LE(offset);                    offset += 4
    const audioFormat  = buffer.readUInt16LE(offset);                    offset += 2
    const channels     = buffer.readUInt16LE(offset);                    offset += 2
    const sampleRate   = buffer.readUInt32LE(offset);                    offset += 4
    const byteRate     = buffer.readUInt32LE(offset);                    offset += 4
    const blockAlign   = buffer.readUInt16LE(offset);                    offset += 2
    const bitDepth     = buffer.readUInt16LE(offset);                    offset += 2
    const data         = buffer.subarray(offset, offset + 4).toString(); offset += 4
    const dataLength   = buffer.readUInt32LE(offset);                    offset += 4

    if (riffHead !== "RIFF")
        throw new Error(`Invalid WAV file: expected RIFF header, got "${riffHead}"`)
    if (waveHead !== "WAVE")
        throw new Error(`Invalid WAV file: expected WAVE header, got "${waveHead}"`)
    if (fmtHead !== "fmt ")
        throw new Error(`Invalid WAV file: expected "fmt " header, got "${fmtHead}"`)
    if (data !== "data")
        throw new Error(`Invalid WAV file: expected "data" header, got "${data}"`)

    return {
        riffHead, fileSize, waveHead, fmtHead, formatLength, audioFormat,
        channels, sampleRate, byteRate, blockAlign, bitDepth, data, dataLength
    }
}

/*  SpeechFlow node for WAV format conversion  */
export default class SpeechFlowNodeA2AWAV extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-wav"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            mode: { type: "string", pos: 1, val: "encode", match: /^(?:encode|decode)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  establish a transform stream  */
        const self = this
        let firstChunk = true
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (firstChunk) {
                    if (self.params.mode === "encode") {
                        /*  convert raw/PCM to WAV/PCM
                            (NOTICE: as this is a continuous stream, the
                            resulting WAV header is not 100% conforming
                            to the WAV standard, as it has to use a zero
                            duration information. This cannot be changed in
                            a stream-based processing.)  */
                        const headerBuffer = writeWavHeader(0, {
                            audioFormat: 0x0001 /* PCM */,
                            channels:    self.config.audioChannels,
                            sampleRate:  self.config.audioSampleRate,
                            bitDepth:    self.config.audioBitDepth
                        })
                        const headerChunk = chunk.clone()
                        headerChunk.payload = headerBuffer
                        this.push(headerChunk)
                        this.push(chunk)
                        callback()
                    }
                    else if (self.params.mode === "decode") {
                        /*  convert WAV/PCM to raw/PCM  */
                        if (chunk.payload.length < 44) {
                            callback(new Error("WAV header too short, expected at least 44 bytes"))
                            return
                        }
                        const header = readWavHeader(chunk.payload)
                        self.log("info", "WAV audio stream: " +
                            `audioFormat=${header.audioFormat === 0x0001 ? "PCM" :
                                "0x" + (header.audioFormat as number).toString(16).padStart(4, "0")} ` +
                            `channels=${header.channels} ` +
                            `sampleRate=${header.sampleRate} ` +
                            `bitDepth=${header.bitDepth}`)
                        if (header.audioFormat !== 0x0001 /* PCM */) {
                            callback(new Error("WAV not based on PCM format"))
                            return
                        }
                        if (header.bitDepth !== self.config.audioBitDepth) {
                            callback(new Error(`WAV not based on ${self.config.audioBitDepth} bit samples`))
                            return
                        }
                        if (header.sampleRate !== self.config.audioSampleRate) {
                            callback(new Error(`WAV not based on ${self.config.audioSampleRate}Hz sample rate`))
                            return
                        }
                        if (header.channels !== self.config.audioChannels) {
                            callback(new Error(`WAV not based on ${self.config.audioChannels} channel(s)`))
                            return
                        }
                        chunk.payload = chunk.payload.subarray(44)
                        this.push(chunk)
                        callback()
                    }
                    else {
                        callback(new Error(`invalid operation mode "${self.params.mode}"`))
                        return
                    }
                    firstChunk = false
                }
                else {
                    /*  pass-through original chunk  */
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
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

