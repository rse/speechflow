/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path from "node:path"

/*  external dependencies  */
import { AudioContext, AudioWorkletNode } from "node-web-audio-api"

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
        const url = path.resolve(__dirname, "speechflow-utils-audio-wt.js")
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
                    this.captureNode?.port.postMessage({
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
            /* ignored - cleanup during shutdown */
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
