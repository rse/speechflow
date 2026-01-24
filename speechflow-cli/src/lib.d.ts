/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/* eslint-disable no-unused-vars */

/*  type definitions for Stream.compose  */
declare module "node:stream" {
    import { Stream, Duplex } from "node:stream"
    export function compose (...streams: Stream[]): Duplex
}

/*  type definitions for AudioWorkletProcessor  */
declare interface AudioWorkletProcessorType {
    readonly port: MessagePort
    process(
        inputs:  Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean
}
declare const AudioWorkletProcessor: {
    prototype: AudioWorkletProcessorType
    new(): AudioWorkletProcessorType
}
declare interface AudioParamDescriptor {
    name:            string
    defaultValue?:   number
    minValue?:       number
    maxValue?:       number
    automationRate?: "a-rate" | "k-rate"
}
declare function registerProcessor (
    name: string,
    processorCtor: new (...args: any[]) => AudioWorkletProcessorType
): void

/*  type definition for "shell-parser"  */
declare module "shell-parser" {
    export default function shellParser (command: string): string[]
}

/*  type definition for "sherpa-onnx"  */
declare module "sherpa-onnx" {
    export interface SherpaOnnxDenoiserConfig {
        model: {
            gtcrn: {
                model: string
            }
        },
        numThreads?: number,
        provider?:   string,
        debug?:      number
    }
    export interface SherpaOnnxAudioOutput {
        samples: Float32Array
        sampleRate: number
    }
    export interface SherpaOnnxOfflineSpeechDenoiser {
        run(samples: Float32Array, sampleRate: number): SherpaOnnxAudioOutput
    }
    export interface SherpaOnnxModule {
        createOfflineSpeechDenoiser(config: SherpaOnnxDenoiserConfig): SherpaOnnxOfflineSpeechDenoiser
    }
    const SherpaOnnx: SherpaOnnxModule
    export default SherpaOnnx
}

/* eslint-enable no-unused-vars */

