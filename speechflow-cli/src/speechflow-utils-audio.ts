/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

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
    const dataView = new DataView(buf.buffer)
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

/*  helper function: convert In16Array in PCM/I16 to Buffer  */
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

/*  helper functions for linear/decibel conversions  */
export function lin2dB (x: number): number {
    return 20 * Math.log10(Math.max(x, 1e-12))
}
export function dB2lin (db: number): number {
    return Math.pow(10, db / 20)
}
