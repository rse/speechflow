/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  internal types  */
interface InputChunkMessage {
    type: "input-chunk"
    chunkId: string
    data: { pcmData: Float32Array, channels: number }
}
interface StartCaptureMessage {
    type: "start-capture"
    chunkId: string
    expectedSamples: number
}
interface CancelCaptureMessage {
    type: "cancel-capture"
    chunkId: string
}
interface CancelAllCapturesMessage {
    type: "cancel-all-captures"
}
type WorkletMessage = InputChunkMessage | StartCaptureMessage | CancelCaptureMessage | CancelAllCapturesMessage
interface ChunkData {
    data: Float32Array
    chunkId: string
}
interface ChunkStartedMessage {
    type: "chunk-started"
    chunkId: string
}
interface CaptureReadyMessage {
    type: "capture-ready"
    chunkId: string
}
interface CaptureCompleteMessage {
    type: "capture-complete"
    chunkId: string
    data: number[]
}

/*  audio source node  */
class AudioSourceProcessor extends AudioWorkletProcessor {
    /*  internal state  */
    private pendingData:  ChunkData[] = []
    private currentChunk: ChunkData | null = null
    private currentOffset = 0

    /*  node construction  */
    constructor () {
        super()

        /*  receive input chunks  */
        this.port.addEventListener("message", (event: MessageEvent<WorkletMessage>) => {
            const { type } = event.data
            if (type === "input-chunk")
                this.pendingData.push({
                    data:    event.data.data.pcmData,
                    chunkId: event.data.chunkId
                })
        })
    }

    /*  process audio frame  */
    process (
        inputs:     Float32Array[][],            /* unused */
        outputs:    Float32Array[][],
        parameters: Record<string, Float32Array> /* unused */
    ): boolean {
        /*  determine output  */
        const output = outputs[0]
        if (!output || output.length === 0)
            return true
        const frameCount = output[0].length
        const channelCount = output.length

        /*  get current chunk if we don't have one  */
        if (this.currentChunk === null && this.pendingData.length > 0) {
            this.currentChunk = this.pendingData.shift()!
            this.currentOffset = 0

            /*  signal chunk start  */
            const message: ChunkStartedMessage = {
                type: "chunk-started",
                chunkId: this.currentChunk.chunkId
            }
            this.port.postMessage(message)
        }

        /*  process input  */
        if (this.currentChunk) {
            /*  output current chunk  */
            const samplesPerChannel = this.currentChunk.data.length / channelCount
            const remainingFrames   = samplesPerChannel - this.currentOffset
            const framesToProcess   = Math.min(frameCount, remainingFrames)

            /*  copy data from current chunk (interleaved to planar)  */
            for (let frame = 0; frame < framesToProcess; frame++) {
                for (let ch = 0; ch < channelCount; ch++) {
                    const interleavedIndex = (this.currentOffset + frame) * channelCount + ch
                    output[ch][frame] = this.currentChunk.data[interleavedIndex] ?? 0
                }
            }

            /*  zero-pad remaining output if needed  */
            for (let frame = framesToProcess; frame < frameCount; frame++)
                for (let ch = 0; ch < channelCount; ch++)
                    output[ch][frame] = 0

            /*  check if current chunk is finished  */
            this.currentOffset += framesToProcess
            if (this.currentOffset >= samplesPerChannel) {
                this.currentChunk  = null
                this.currentOffset = 0
            }
        }
        else {
            /*  output silence when no input  */
            for (let ch = 0; ch < channelCount; ch++)
                output[ch].fill(0)
        }
        return true
    }
}

/*  audio capture node  */
class AudioCaptureProcessor extends AudioWorkletProcessor {
    /*  internal state  */
    private static readonly CAPTURE_TTL = 30 * 1000
    private activeCaptures = new Map<string, { data: number[], expectedSamples: number, createdAt: number }>()

    /*  node construction  */
    constructor () {
        super()

        /*  receive start of capturing command  */
        this.port.addEventListener("message", (event: MessageEvent<WorkletMessage>) => {
            const { type } = event.data
            if (type === "start-capture") {
                const chunkId = event.data.chunkId
                this.activeCaptures.set(chunkId, {
                    data: [],
                    expectedSamples: event.data.expectedSamples,
                    createdAt: Date.now()
                })

                /*  acknowledge capture registration  */
                const ready: CaptureReadyMessage = {
                    type: "capture-ready",
                    chunkId
                }
                this.port.postMessage(ready)
            }
            else if (type === "cancel-capture") {
                const chunkId = event.data.chunkId
                this.activeCaptures.delete(chunkId)
            }
            else if (type === "cancel-all-captures")
                this.activeCaptures.clear()
        })
    }

    /*  process audio frame  */
    process (
        inputs:     Float32Array[][],
        outputs:    Float32Array[][],             /* unused */
        parameters: Record<string, Float32Array>  /* unused */
    ): boolean {
        /*  determine input  */
        const input = inputs[0]
        if (!input || input.length === 0 || this.activeCaptures.size === 0)
            return true
        const frameCount = input[0].length
        const channelCount = input.length

        /*  evict stale captures (TTL safety net)  */
        const currentTime = Date.now()
        for (const [ chunkId, capture ] of this.activeCaptures) {
            if ((currentTime - capture.createdAt) > AudioCaptureProcessor.CAPTURE_TTL)
                this.activeCaptures.delete(chunkId)
        }
        if (this.activeCaptures.size === 0)
            return true

        /*  iterate over all active captures  */
        for (const [ chunkId, capture ] of this.activeCaptures) {
            /*  convert planar to interleaved  */
            for (let frame = 0; frame < frameCount; frame++)
                for (let ch = 0; ch < channelCount; ch++)
                    capture.data.push(input[ch][frame])

            /*  send back captured data  */
            if (capture.data.length >= capture.expectedSamples) {
                const message: CaptureCompleteMessage = {
                    type: "capture-complete",
                    chunkId,
                    data: capture.data.slice(0, capture.expectedSamples)
                }
                this.port.postMessage(message)
                this.activeCaptures.delete(chunkId)
            }
        }
        return true
    }
}

/*  register the new audio nodes  */
registerProcessor("source",  AudioSourceProcessor)
registerProcessor("capture", AudioCaptureProcessor)
