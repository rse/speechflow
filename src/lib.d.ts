/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

declare module "pcm-convert" {
    interface Format {
        dtype:       string
        channels:    number
        interleaved: boolean
        endianness:  string
    }
    export default function pcmconvert (
        data:        Buffer,
        srcFormat:   Format,
        dstFormat:   Format
    ): any
}

declare module "node:stream" {
    import { Stream, Duplex } from "node:stream"
    export function compose (...streams: Stream[]): Duplex
}

