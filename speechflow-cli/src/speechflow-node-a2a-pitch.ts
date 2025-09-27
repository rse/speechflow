/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream  from "node:stream"

/*  external dependencies  */
import FFT     from "fft.js"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  internal types  */
interface PitchConfig {
    shift?:     number
    frameSize?: number
    overlap?:   number
}

/*  audio pitch shifter class  */
class PitchShifter {
    /*  internal state  */
    private config:        Required<PitchConfig>
    private fft:           FFT
    private frameBuffer:   Float32Array
    private frameBufferIdx = 0
    private outputBuffer:  Float32Array
    private overlapBuffer: Float32Array

    /*  construct object  */
    constructor(
        config: PitchConfig = {}
    ) {
        /*  store configuration  */
        this.config = {
            shift:     config.shift     ?? 1.2,
            frameSize: config.frameSize ?? 1024,
            overlap:   config.overlap   ?? 0.5
        }

        /*  initialize FFT  */
        this.fft = new FFT(this.config.frameSize)

        /*  initialize buffers  */
        this.frameBuffer   = new Float32Array(this.config.frameSize)
        this.outputBuffer  = new Float32Array(this.config.frameSize)
        this.overlapBuffer = new Float32Array(this.config.frameSize)
    }

    /*  process audio data with pitch shifting  */
    async process (inputFloat: Float32Array): Promise<Float32Array> {
        /*  process input frames  */
        const outputFloat = new Float32Array(inputFloat.length)
        let outputIndex = 0

        for (let i = 0; i < inputFloat.length; i++) {
            this.frameBuffer[this.frameBufferIdx++] = inputFloat[i]
            if (this.frameBufferIdx >= this.config.frameSize) {
                /*  process current frame  */
                const processedFrame = this.processFrame(this.frameBuffer)

                /*  merge processed and overlap frame  */
                for (let j = 0; j < this.config.frameSize; j++)
                    this.outputBuffer[j] = processedFrame[j] + this.overlapBuffer[j]

                /*  store overlap for next frame  */
                const hopSize = Math.floor(this.config.frameSize * (1 - this.config.overlap))
                for (let j = 0; j < this.config.frameSize - hopSize; j++)
                    this.overlapBuffer[j] = processedFrame[j + hopSize]
                for (let j = this.config.frameSize - hopSize; j < this.config.frameSize; j++)
                    this.overlapBuffer[j] = 0

                /*  copy output samples  */
                const samplesToOutput = Math.min(hopSize, outputFloat.length - outputIndex)
                for (let j = 0; j < samplesToOutput; j++)
                    outputFloat[outputIndex++] = this.outputBuffer[j]

                /*  shift frame buffer for overlap  */
                for (let j = 0; j < this.config.frameSize - hopSize; j++)
                    this.frameBuffer[j] = this.frameBuffer[j + hopSize]
                this.frameBufferIdx = this.config.frameSize - hopSize
            }
        }

        return outputFloat
    }

    /*  process single frame with pitch shifting  */
    private processFrame (frame: Float32Array): Float32Array {
        /*  apply window function (Hann window)  */
        const windowed = new Float32Array(this.config.frameSize)
        for (let i = 0; i < this.config.frameSize; i++) {
            const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.config.frameSize - 1)))
            windowed[i] = frame[i] * window
        }

        /*  apply forward Fast Fourier Transform (FFT)  */
        const spectrum = new Float32Array(this.fft.createComplexArray())
        this.fft.realTransform(spectrum, windowed)

        /*  shift spectrum for pitch change  */
        const shiftedSpectrum = this.shiftSpectrum(spectrum, this.config.shift)

        /*  apply inverse Fast Fourier Transform (FFT)  */
        const output = new Float32Array(this.config.frameSize)
        this.fft.inverseTransform(shiftedSpectrum, output)

        /*  normalize output (FFT scaling)  */
        const scale = 1.0 / this.config.frameSize
        for (let i = 0; i < this.config.frameSize; i++)
            output[i] *= scale

        return output
    }

    /*  shift frequency spectrum for pitch change  */
    private shiftSpectrum (spectrum: Float32Array, shift: number): Float32Array {
        if (!spectrum || spectrum.length === 0)
            throw new Error("invalid spectrum: must be non-empty Float32Array")
        if (spectrum.length % 2 !== 0)
            throw new Error("invalid spectrum: length must be even for complex data")

        const shifted = new Float32Array(spectrum.length)
        const numBins = spectrum.length / 2

        /*  preserve Direct Current (DC) component  */
        shifted[0] = spectrum[0]
        shifted[1] = 0

        /*  shift frequencies with interpolation  */
        for (let bin = 1; bin < numBins; bin++) {
            const targetBin = bin * shift
            const targetBinInt = Math.floor(targetBin)
            const frac = targetBin - targetBinInt

            if (targetBinInt < numBins - 1) {
                const realIdx = bin * 2
                const imagIdx = bin * 2 + 1
                const targetRealIdx = targetBinInt * 2
                const targetImagIdx = targetBinInt * 2 + 1

                /*  get complex values  */
                const real = spectrum[realIdx]
                const imag = spectrum[imagIdx]

                /*  simple frequency shifting without interpolation for now  */
                if (targetBinInt > 0 && targetBinInt < numBins) {
                    shifted[targetRealIdx] += real * (1 - frac)
                    shifted[targetImagIdx] += imag * (1 - frac)
                    if (targetBinInt + 1 < numBins) {
                        shifted[targetRealIdx + 2] += real * frac
                        shifted[targetImagIdx + 2] += imag * frac
                    }
                }
            }
        }
        return shifted
    }
}

/*  SpeechFlow node for pitch adjustment in audio-to-audio passing  */
export default class SpeechFlowNodeA2APitch extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "a2a-pitch"

    /*  internal state  */
    private closing = false
    private pitchShifter: PitchShifter | null = null
    private processingQueue: Promise<void> = Promise.resolve()

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            shift:     { type: "number", val: 1.2,  match: (n: number) => n >= 0.5 && n <= 2.0 },
            frameSize: { type: "number", val: 1024, match: (n: number) => n >= 256 && n <= 4096 && (n & (n - 1)) === 0 },
            overlap:   { type: "number", val: 0.5,  match: (n: number) => n >= 0.0 && n <= 0.9 }
        })

        /*  declare node input/output format  */
        this.input  = "audio"
        this.output = "audio"
    }

    /*  open node  */
    async open () {
        /*  clear destruction flag  */
        this.closing = false

        /*  reset processing queue  */
        this.processingQueue = Promise.resolve()

        /*  setup pitch shifter  */
        this.pitchShifter = new PitchShifter({
            shift:     this.params.shift,
            frameSize: this.params.frameSize,
            overlap:   this.params.overlap
        })

        /*  establish a transform stream  */
        const self = this
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            transform (chunk: SpeechFlowChunk & { payload: Buffer }, encoding, callback) {
                if (self.closing) {
                    callback(new Error("stream already destroyed"))
                    return
                }
                if (!Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else {
                    /*  queue processing to maintain order  */
                    self.processingQueue = self.processingQueue.then(async () => {
                        if (self.closing)
                            throw new Error("stream already destroyed")

                        /*  shift pitch of audio chunk  */
                        const payload = util.convertBufToF32(chunk.payload, self.config.audioLittleEndian)
                        const result = await self.pitchShifter?.process(payload)
                        if (self.closing)
                            throw new Error("stream already destroyed")

                        /*  take over pitch-shifted data  */
                        const outputPayload = util.convertF32ToBuf(result!)
                        chunk.payload = outputPayload
                        this.push(chunk)
                        callback()
                    }).catch((error: unknown) => {
                        if (!self.closing)
                            callback(util.ensureError(error, "pitch shifting failed"))
                    })
                }
            },
            final (callback) {
                if (self.closing) {
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
        /*  indicate closing  */
        this.closing = true

        /*  destroy pitch shifter  */
        if (this.pitchShifter !== null)
            this.pitchShifter = null

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
