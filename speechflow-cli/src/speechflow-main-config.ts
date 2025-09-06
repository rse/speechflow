/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  the node configuration  */
export class NodeConfig {
    constructor (
        public readonly audioChannels      = 1,
        public readonly audioBitDepth      = 16,
        public readonly audioLittleEndian  = true,
        public readonly audioSampleRate    = 48000,
        public readonly textEncoding       = "utf8",
        public cacheDir                    = ""
    ) {}
}
