/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path from "node:path"

/*  external dependencies  */
import { AudioContext, AudioWorkletNode } from "node-web-audio-api"

/*  calculate duration of an audio buffer  */
export function audioBufferDuration (
    buffer: Buffer,
    sampleRate   = 48000,
    bitDepth     = 16,
    channels     = 1,
    littleEndian = true
) {
    /*  sanity check parameters  */
    if (!Buffer.isBuffer(buffer))
        throw new Error("invalid input (Buffer expected)")
    if (littleEndian !== true)
        throw new Error("only Little Endian supported")
    if (sampleRate <= 0)
        throw new Error("sample rate must be positive")
    if (bitDepth <= 0 || bitDepth % 8 !== 0)
        throw new Error("bit depth must be positive and multiple of 8")
    if (channels <= 0)
        throw new Error("channels must be positive")

    /*  calculate duration  */
    const bytesPerSample = bitDepth / 8
    const totalSamples = buffer.length / (bytesPerSample * channels)
    return totalSamples / sampleRate
}

/*  calculate duration of an audio array  */
export function audioArrayDuration (
    arr: Float32Array,
    sampleRate   = 48000,
    channels     = 1
) {
    /*  sanity check parameters  */
    if (arr.length === 0)
        return 0
    if (sampleRate <= 0)
        throw new Error("sample rate must be positive")
    if (channels <= 0)
        throw new Error("channels must be positive")

    /*  calculate duration  */
    const totalSamples = arr.length / channels
    return totalSamples / sampleRate
}

/*  helper function: convert Buffer in PCM/I16 to Float32Array in PCM/F32 format  */
export function convertBufToF32 (buf: Buffer, littleEndian = true) {
    if (buf.length % 2 !== 0)
        throw new Error("buffer length must be even for 16-bit samples")
    const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const arr = new Float32Array(buf.length / 2)
    for (let i = 0; i < arr.length; i++)
        arr[i] = dataView.getInt16(i * 2, littleEndian) / 32768
    return arr
}

/*  helper function: convert Float32Array in PCM/F32 to Buffer in PCM/I16 format  */
export function convertF32ToBuf (arr: Float32Array) {
    if (arr.length === 0)
        return Buffer.alloc(0)
    const int16Array = new Int16Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
        let sample = arr[i]
        if (Number.isNaN(sample))
            sample = 0
        int16Array[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)))
    }
    return Buffer.from(int16Array.buffer)
}

/*  helper function: convert Buffer in PCM/I16 to Int16Array  */
export function convertBufToI16 (buf: Buffer, littleEndian = true) {
    if (buf.length % 2 !== 0)
        throw new Error("buffer length must be even for 16-bit samples")
    const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const arr = new Int16Array(buf.length / 2)
    for (let i = 0; i < buf.length / 2; i++)
        arr[i] = dataView.getInt16(i * 2, littleEndian)
    return arr
}

/*  helper function: convert Int16Array in PCM/I16 to Buffer  */
export function convertI16ToBuf (arr: Int16Array, littleEndian = true) {
    if (arr.length === 0)
        return Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(arr.length * 2)
    for (let i = 0; i < arr.length; i++) {
        if (littleEndian)
            buf.writeInt16LE(arr[i], i * 2)
        else
            buf.writeInt16BE(arr[i], i * 2)
    }
    return buf
}

/*  process Int16Array in fixed-size segments  */
export async function processInt16ArrayInSegments (
    data: Int16Array<ArrayBuffer>,
    segmentSize: number,
    processor: (segment: Int16Array<ArrayBuffer>) => Promise<Int16Array<ArrayBuffer>>
): Promise<Int16Array<ArrayBuffer>> {
    /*  process full segments  */
    let i = 0
    while ((i + segmentSize) <= data.length) {
        const segment = data.slice(i, i + segmentSize)
        const result = await processor(segment)
        data.set(result, i)
        i += segmentSize
    }

    /*  process final partial segment if it exists  */
    if (i < data.length) {
        const len = data.length - i
        const segment = new Int16Array(segmentSize)
        segment.set(data.slice(i), 0)
        segment.fill(0, len, segmentSize)
        const result = await processor(segment)
        data.set(result.slice(0, len), i)
    }
    return data
}

/*  update envelope (smoothed amplitude contour) for single channel  */
export function updateEnvelopeForChannel(
    env:            number[],
    sampleRate:     number,
    chan:           number,
    samples:        Float32Array,
    attack:         number,
    release:        number
): number {
    /*  fetch old envelope value  */
    if (env[chan] === undefined)
        env[chan] = 1e-12
    let currentEnv = env[chan]

    /*  calculate attack/release alpha values  */
    const alphaA = Math.exp(-1 / (attack  * sampleRate))
    const alphaR = Math.exp(-1 / (release * sampleRate))

    /*  iterate over all samples and calculate RMS  */
    for (const s of samples) {
        const x = Math.abs(s)
        const det = x * x
        if (det > currentEnv)
            currentEnv = alphaA * currentEnv + (1 - alphaA) * det
        else
            currentEnv = alphaR * currentEnv + (1 - alphaR) * det
    }
    return Math.sqrt(Math.max(currentEnv, 1e-12))
}

/*  helper functions for linear/decibel conversions  */
export function lin2dB (x: number): number {
    return 20 * Math.log10(Math.max(x, 1e-12))
}
export function dB2lin (db: number): number {
    return Math.pow(10, db / 20)
}

export class WebAudio {
    /*  internal state  */
    public audioContext: AudioContext
    public sourceNode:   AudioWorkletNode | null = null
    public captureNode:  AudioWorkletNode | null = null
    private pendingPromises = new Map<string, {
        resolve: (value: Int16Array) => void
        reject: (error: Error) => void
        timeout: ReturnType<typeof setTimeout>
    }>()

    /*  construct object  */
    constructor(
        public sampleRate: number,
        public channels: number
    ) {
        /*  create new audio context  */
        this.audioContext = new AudioContext({
            sampleRate,
            latencyHint: "interactive"
        })
    }

    /*  setup object  */
    public async setup (): Promise<void> {
        /*  ensure audio context is not suspended  */
        if (this.audioContext.state === "suspended")
            await this.audioContext.resume()

        /*  add audio worklet module  */
        const url = path.resolve(__dirname, "speechflow-util-audio-wt.js")
        await this.audioContext.audioWorklet.addModule(url)

        /*  create source node  */
        this.sourceNode = new AudioWorkletNode(this.audioContext, "source", {
            numberOfInputs:  0,
            numberOfOutputs: 1,
            outputChannelCount: [ this.channels ]
        })

        /*  create capture node  */
        this.captureNode = new AudioWorkletNode(this.audioContext, "capture", {
            numberOfInputs:  1,
            numberOfOutputs: 0
        })
        this.captureNode!.port.addEventListener("message", (event) => {
            const { type, chunkId, data } = event.data ?? {}
            if (type === "capture-complete") {
                const promise = this.pendingPromises.get(chunkId)
                if (promise) {
                    clearTimeout(promise.timeout)
                    this.pendingPromises.delete(chunkId)
                    const int16Data = new Int16Array(data.length)
                    for (let i = 0; i < data.length; i++)
                        int16Data[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)))
                    promise.resolve(int16Data)
                }
            }
        })

        /*  start ports  */
        this.sourceNode.port.start()
        this.captureNode!.port.start()
    }

    /*  process single audio chunk  */
    public async process (int16Array: Int16Array): Promise<Int16Array> {
        const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
        return new Promise<Int16Array>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPromises.delete(chunkId)
                reject(new Error("processing timeout"))
            }, (int16Array.length / this.audioContext.sampleRate) * 1000 + 250)
            if (this.captureNode !== null)
                this.pendingPromises.set(chunkId, { resolve, reject, timeout })
            try {
                const float32Data = new Float32Array(int16Array.length)
                for (let i = 0; i < int16Array.length; i++)
                    float32Data[i] = int16Array[i] / 32768.0

                /*  start capture first  */
                if (this.captureNode !== null) {
                    this.captureNode.port.postMessage({
                        type: "start-capture",
                        chunkId,
                        expectedSamples: int16Array.length
                    })
                }

                /*  small delay to ensure capture is ready before sending data  */
                setTimeout(() => {
                    /*  send input to source node  */
                    this.sourceNode?.port.postMessage({
                        type: "input-chunk",
                        chunkId,
                        data: { pcmData: float32Data, channels: this.channels }
                    }, [ float32Data.buffer ])
                }, 5)
            }
            catch (error) {
                clearTimeout(timeout)
                if (this.captureNode !== null)
                    this.pendingPromises.delete(chunkId)
                reject(new Error(`failed to process chunk: ${error}`))
            }
        })
    }

    public async destroy (): Promise<void> {
        /*  reject all pending promises  */
        try {
            this.pendingPromises.forEach(({ reject, timeout }) => {
                clearTimeout(timeout)
                reject(new Error("WebAudio destroyed"))
            })
            this.pendingPromises.clear()
        }
        catch (_err) {
            /*  ignored -- cleanup during shutdown  */
        }

        /*  disconnect nodes  */
        if (this.sourceNode !== null) {
            this.sourceNode.disconnect()
            this.sourceNode = null
        }
        if (this.captureNode !== null) {
            this.captureNode.disconnect()
            this.captureNode = null
        }

        /*  stop context  */
        await this.audioContext.close()
    }
}
