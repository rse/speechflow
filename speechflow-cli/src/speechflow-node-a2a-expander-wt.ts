/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import * as utils from "./speechflow-utils"

/*  downward expander with soft knee  */
class ExpanderProcessor extends AudioWorkletProcessor {
    /*  internal state  */
    private env: number[] = []
    private sampleRate: number

    /*  eslint no-undef: off */
    static get parameterDescriptors(): AudioParamDescriptor[] {
        return [
            { name: "threshold",  defaultValue: -45,   minValue: -100,   maxValue: 0,   automationRate: "k-rate" }, // dBFS
            { name: "floor",      defaultValue: -64,   minValue: -100,   maxValue: 0,   automationRate: "k-rate" }, // dBFS minimum output level
            { name: "ratio",      defaultValue: 4.0,   minValue: 1.0,    maxValue: 20,  automationRate: "k-rate" }, // expansion ratio
            { name: "attack",     defaultValue: 0.010, minValue: 0.0,    maxValue: 1,   automationRate: "k-rate" }, // seconds
            { name: "release",    defaultValue: 0.050, minValue: 0.0,    maxValue: 1,   automationRate: "k-rate" }, // seconds
            { name: "knee",       defaultValue: 6.0,   minValue: 0.0,    maxValue: 40,  automationRate: "k-rate" }, // dB
            { name: "makeup",     defaultValue: 0.0,   minValue: -24,    maxValue: 24,  automationRate: "k-rate" }  // dB
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

        /*  determine thresholds  */
        const halfKnee  = kneeDB * 0.5
        const belowKnee = levelDB < (thresholdDB - halfKnee)
        const aboveThr  = levelDB >= thresholdDB

        /*  short-circuit for no expansion (above threshold)  */
        if (aboveThr)
            return 0

        /*  apply soft-knee  */
        if (kneeDB > 0 && !belowKnee) {
            const x = (levelDB - (thresholdDB - halfKnee)) / kneeDB
            const idealGainDB = (thresholdDB + (levelDB - thresholdDB) * ratio) - levelDB
            return idealGainDB * x * x
        }

        /*  determine target level  */
        const targetOut = thresholdDB + (levelDB - thresholdDB) / ratio

        /*  return gain difference  */
        return targetOut - levelDB
    }

    /*  update envelope (smoothed amplitude contour) for single channel  */
    private updateEnvelopeForChannel (
        chan:           number,
        samples:        Float32Array,
        attack:         number,
        release:        number
    ): void {
        /*  fetch old envelope value  */
        if (this.env[chan] === undefined)
            this.env[chan] = 1e-12
        let env = this.env[chan]

        /*  calculate attack/release alpha values  */
        const alphaA = Math.exp(-1 / (attack  * this.sampleRate))
        const alphaR = Math.exp(-1 / (release * this.sampleRate))

        /*  iterate over all samples and calculate RMS  */
        for (const s of samples) {
            const x = Math.abs(s)
            const det = x * x
            if (det > env)
                env = alphaA * env + (1 - alphaA) * det
            else
                env = alphaR * env + (1 - alphaR) * det
        }
        this.env[chan] = Math.sqrt(Math.max(env, 1e-12))
    }

    /*  process a single sample frame  */
    process(
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
        const floorDB     = parameters["floor"][0]
        const ratio       = parameters["ratio"][0]
        const kneeDB      = parameters["knee"][0]
        const attackS     = Math.max(parameters["attack"][0],  1 / this.sampleRate)
        const releaseS    = Math.max(parameters["release"][0], 1 / this.sampleRate)
        const makeupDB    = parameters["makeup"][0]

        /*  update envelope per channel  */
        for (let ch = 0; ch < nCh; ch++)
            this.updateEnvelopeForChannel(ch, input[ch], attackS, releaseS)

        /*  determine linear value from decibel makeup value */
        const makeUpLin = utils.dB2lin(makeupDB)

        /*  iterate over all channels  */
        for (let ch = 0; ch < nCh; ch++) {
            const levelDB = utils.lin2dB(this.env[ch])
            const gainDB  = this.gainDBFor(levelDB, thresholdDB, ratio, kneeDB)
            let gainLin = utils.dB2lin(gainDB) * makeUpLin

            /*  do not attenuate below floor  */
            const expectedOutLevelDB = levelDB + gainDB + makeupDB
            if (expectedOutLevelDB < floorDB) {
                const neededLiftDB = floorDB - expectedOutLevelDB
                gainLin /= utils.dB2lin(neededLiftDB)
            }

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
registerProcessor("expander", ExpanderProcessor)
