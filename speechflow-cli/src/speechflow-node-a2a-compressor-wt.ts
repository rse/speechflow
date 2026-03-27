/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  internal dependencies  */
import * as util from "./speechflow-util"

/*  downward compressor with soft knee  */
class CompressorProcessor extends AudioWorkletProcessor {
    /*  internal state  */
    private env: number[] = []
    private sampleRate: number
    public reduction = 0

    /*  eslint no-undef: off */
    static get parameterDescriptors (): AudioParamDescriptor[] {
        return [
            { name: "threshold",  defaultValue: -23,   minValue: -100,   maxValue: 0,   automationRate: "k-rate" }, // dBFS
            { name: "ratio",      defaultValue: 4.0,   minValue: 1.0,    maxValue: 20,  automationRate: "k-rate" }, // compression ratio
            { name: "attack",     defaultValue: 0.010, minValue: 0.0,    maxValue: 1,   automationRate: "k-rate" }, // seconds
            { name: "release",    defaultValue: 0.050, minValue: 0.0,    maxValue: 1,   automationRate: "k-rate" }, // seconds
            { name: "knee",       defaultValue: 6.0,   minValue: 0.0,    maxValue: 40,  automationRate: "k-rate" }  // dB
        ]
    }

    /*  class constructor for custom option processing  */
    constructor (options: any) {
        super()
        const { sampleRate } = options.processorOptions
        this.sampleRate = sampleRate as number
    }

    /*  determine gain difference  */
    private gainDBFor (levelDB: number, thresholdDB: number, ratio: number, kneeDB: number): number {
        /*  short-circuit for unreasonable ratio  */
        if (ratio <= 1.0)
            return 0

        /*  determine knee boundaries (symmetric around threshold)  */
        const halfKnee  = kneeDB * 0.5
        const belowKnee = levelDB < (thresholdDB - halfKnee)
        const aboveKnee = levelDB > (thresholdDB + halfKnee)

        /*  short-circuit for no compression (below knee)  */
        if (belowKnee)
            return 0

        /*  apply soft-knee (standard textbook quadratic)  */
        if (kneeDB > 0 && !aboveKnee) {
            const d = levelDB - thresholdDB + halfKnee
            return (1.0 / ratio - 1.0) * d * d / (2.0 * kneeDB)
        }

        /*  determine target level  */
        const targetOut = thresholdDB + (levelDB - thresholdDB) / ratio

        /*  return gain difference  */
        return targetOut - levelDB
    }

    /*  process a single sample frame  */
    process (
        inputs:     Float32Array[][],
        outputs:    Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean {
        /*  sanity check  */
        const input  = inputs[0]
        const output = outputs[0]
        if (!input || input.length === 0 || !output)
            return true

        /*  determine number of channels  */
        const nCh = input.length

        /*  reset envelope array if channel count changed  */
        if (nCh !== this.env.length)
            this.env = []

        /*  initially just copy input to output (pass-through)  */
        for (let c = 0; c < output.length; c++) {
            if (!output[c] || !input[c])
                continue
            output[c].set(input[c])
        }

        /*  fetch parameters  */
        const thresholdDB = parameters["threshold"][0]
        const ratio       = parameters["ratio"][0]
        const kneeDB      = parameters["knee"][0]
        const attackS     = Math.max(parameters["attack"][0],  1 / this.sampleRate)
        const releaseS    = Math.max(parameters["release"][0], 1 / this.sampleRate)

        /*  update envelope per channel and collect RMS values  */
        const rms = Array.from<number>({ length: nCh })
        for (let ch = 0; ch < nCh; ch++)
            rms[ch] = util.updateEnvelopeForChannel(this.env, this.sampleRate, ch, input[ch], attackS, releaseS)

        /*  iterate over all channels  */
        this.reduction = 0
        for (let ch = 0; ch < nCh; ch++) {
            const levelDB = util.lin2dB(rms[ch])
            const gainDB  = this.gainDBFor(levelDB, thresholdDB, ratio, kneeDB)
            const gainLin = util.dB2lin(gainDB)

            /*  on first channel, calculate reduction  */
            if (ch === 0)
                this.reduction = Math.min(0, gainDB)

            /*  apply gain change to channel  */
            const inp = input[ch]
            const out = output[ch]
            for (let i = 0; i < inp.length; i++)
                out[i] = inp[i] * gainLin
        }
        return true
    }
}

/*  register the new audio nodes  */
registerProcessor("compressor", CompressorProcessor)
