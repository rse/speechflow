/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import Stream           from "node:stream"
import PortAudio        from "@gpeng/naudiodon"
import SpeechFlowNode   from "./speechflow-node"
import SpeechFlowUtil   from "./speechflow-util"

export default class SpeechFlowNodeDevice extends SpeechFlowNode {
    private io: PortAudio.IoStreamRead | PortAudio.IoStreamWrite | PortAudio.IoStreamDuplex | null = null
    constructor (id: string, opts: { [ id: string ]: any }, args: any[]) {
        super(id, opts, args)
        this.configure({
            device: { type: "string", pos: 0,            match: /^(.+?):(.+)$/ },
            mode:   { type: "string", pos: 1, val: "rw", match: /^(?:r|w|rw)$/ }
        })
    }
    async open () {
        /*  determine device  */
        const device = SpeechFlowUtil.audioDeviceFromURL(this.params.mode, this.params.device)

        /*  sanity check sample rate compatibility
            (we still do not resample in input/output for simplification reasons)  */
        if (device.defaultSampleRate !== this.config.audioSampleRate)
            throw new Error(`device audio sample rate ${device.defaultSampleRate} is ` +
                `incompatible with required sample rate ${this.config.audioSampleRate}`)

        /*  establish device connection
            Notice: "naudion" actually implements Stream.{Readable,Writable,Duplex}, but
            declares just its sub-interface NodeJS.{Readable,Writable,Duplex}Stream,
            so it is correct to cast it back to Stream.{Readable,Writable,Duplex}  */
        if (device.maxInputChannels > 0 && device.maxOutputChannels > 0) {
            this.log("info", `resolved "${this.params.device}" to duplex device "${device.id}"`)
            this.input  = "audio"
            this.output = "audio"
            this.io = PortAudio.AudioIO({
                inOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                },
                outOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                }
            })
            this.stream = this.io as unknown as Stream.Duplex
        }
        else if (device.maxInputChannels > 0 && device.maxOutputChannels === 0) {
            this.log("info", `resolved "${this.params.device}" to input device "${device.id}"`)
            this.input  = "none"
            this.output = "audio"
            this.io = PortAudio.AudioIO({
                inOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                }
            })
            this.stream = this.io as unknown as Stream.Readable
        }
        else if (device.maxInputChannels === 0 && device.maxOutputChannels > 0) {
            this.log("info", `resolved "${this.params.device}" to output device "${device.id}"`)
            this.input  = "audio"
            this.output = "none"
            this.io = PortAudio.AudioIO({
                outOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                }
            })
            this.stream = this.io as unknown as Stream.Writable
        }
        else
            throw new Error(`device "${device.id}" does not have any input or output channels`)

        /*  pass-through errors  */
        this.io.on("error", (err) => {
            this.emit("error", err)
        })
    }
    async close () {
        if (this.io !== null)
            this.io.quit()
    }
}

