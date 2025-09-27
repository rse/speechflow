/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  pitch shifter audio worklet processor  */
class PitchShifterProcessor extends AudioWorkletProcessor {
    /*  internal state  */
    private shift:          number
    private frameSize:      number
    private overlap:        number
    private hopSize:        number
    private inputBuffer:    Float32Array
    private outputBuffer:   Float32Array
    private overlapBuffer:  Float32Array
    private windowFunction: Float32Array
    private windowedBuffer: Float32Array
    private shiftedBuffer:  Float32Array
    private inputPos        = 0
    private outputPos       = 0

    /*  worklet construction  */
    constructor(options: {
        processorOptions?: {
            shift?:     number
            frameSize?: number
            overlap?:   number
        }
    }) {
        super()

        /*  get configuration from options  */
        const processorOptions = options.processorOptions ?? {}
        this.shift     = processorOptions.shift     ?? 1.0
        this.frameSize = processorOptions.frameSize ?? 2048
        this.overlap   = processorOptions.overlap   ?? 0.5
        this.hopSize   = Math.floor(this.frameSize * (1 - this.overlap))

        /*  initialize buffers  */
        this.inputBuffer    = new Float32Array(this.frameSize * 2)
        this.outputBuffer   = new Float32Array(this.frameSize * 2)
        this.overlapBuffer  = new Float32Array(this.frameSize)
        this.windowFunction = new Float32Array(this.frameSize)
        this.windowedBuffer = new Float32Array(this.frameSize)
        this.shiftedBuffer  = new Float32Array(this.frameSize)

        /*  initialize Hann window  */
        for (let i = 0; i < this.frameSize; i++)
            this.windowFunction[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.frameSize - 1)))
    }

    /*  static parameter descriptors  */
    static get parameterDescriptors() {
        return [ {
            name:         "shift",
            defaultValue: 1.0,
            minValue:     0.25,
            maxValue:     4.0
        } ]
    }

    /*  process audio frame  */
    process(
        inputs:     Float32Array[][],
        outputs:    Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean {
        /*  get input and output arrays  */
        const input  = inputs[0]
        const output = outputs[0]
        if (!input || !output || input.length === 0 || output.length === 0)
            return true

        /*  update shift parameter if provided  */
        const shiftParam = parameters.shift
        if (shiftParam && shiftParam.length > 0)
            this.shift = shiftParam[0]

        /*  determine sizes  */
        const frameCount   = input[0]?.length ?? 0
        const channelCount = Math.min(input.length, output.length)
        if (frameCount === 0)
            return true

        /*  process each channel independently  */
        for (let ch = 0; ch < channelCount; ch++) {
            const inputChannel  = input[ch]
            const outputChannel = output[ch]

            /*  bypass processing if no pitch shift needed  */
            if (Math.abs(this.shift - 1.0) < 0.001) {
                for (let i = 0; i < frameCount; i++)
                    outputChannel[i] = inputChannel[i]
                continue
            }

            /*  process each sample  */
            for (let i = 0; i < frameCount; i++) {
                /*  accumulate input samples  */
                this.inputBuffer[this.inputPos++] = inputChannel[i]

                /*  process when we have enough input  */
                if (this.inputPos >= this.frameSize) {
                    this.processFrame()

                    /*  shift input buffer by hop size  */
                    for (let j = 0; j < this.frameSize - this.hopSize; j++)
                        this.inputBuffer[j] = this.inputBuffer[j + this.hopSize]
                    this.inputPos -= this.hopSize
                }

                /*  output processed samples  */
                if (this.outputPos < this.hopSize)
                    outputChannel[i] = this.outputBuffer[this.outputPos++]
                else
                    outputChannel[i] = 0
            }
        }
        return true
    }

    /*  process a single frame with pitch shifting  */
    private processFrame(): void {
        /*  apply window to input  */
        for (let i = 0; i < this.frameSize; i++)
            this.windowedBuffer[i] = this.inputBuffer[i] * this.windowFunction[i]

        /*  pitch shift using time-domain resampling  */
        const shifted = this.pitchShiftTimeDomain(this.windowedBuffer)

        /*  overlap-add synthesis - copy current overlap buffer to output  */
        for (let i = 0; i < this.hopSize; i++)
            this.outputBuffer[i] = this.overlapBuffer[i]

        /*  add new frame contribution to overlap buffer  */
        for (let i = 0; i < this.frameSize; i++) {
            if (i < this.hopSize)
                this.outputBuffer[i] += shifted[i]
            else
                this.overlapBuffer[i - this.hopSize] = shifted[i]
        }

        /*  reset output position  */
        this.outputPos = 0
    }

    /*  time-domain pitch shifting using resampling  */
    private pitchShiftTimeDomain(frame: Float32Array): Float32Array {
        const output = this.shiftedBuffer

        if (Math.abs(this.shift - 1.0) < 0.001)
            /*  no pitch shift needed  */
            output.set(frame)
        else {
            /*  resample with linear interpolation  */
            const stretchFactor = 1.0 / this.shift
            for (let i = 0; i < this.frameSize; i++) {
                const sourcePos = i * stretchFactor
                const idx0 = Math.floor(sourcePos)
                const idx1 = Math.min(idx0 + 1, this.frameSize - 1)
                const frac = sourcePos - idx0
                if (idx0 < this.frameSize)
                    output[i] = frame[idx0] * (1 - frac) + frame[idx1] * frac
                else
                    output[i] = 0
            }
        }

        /*  apply window to output  */
        for (let i = 0; i < this.frameSize; i++)
            output[i] *= this.windowFunction[i]
        return output
    }
}

/*  register the processor  */
registerProcessor("pitch-shifter", PitchShifterProcessor)
