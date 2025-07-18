/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream           from "node:stream"

/*  external dependencies  */
import PortAudio        from "@gpeng/naudiodon"

/*  internal dependencies  */
import SpeechFlowNode   from "./speechflow-node"
import * as utils       from "./speechflow-utils"

/*  SpeechFlow node for device access  */
export default class SpeechFlowNodeDevice extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "device"

    /*  internal state  */
    private io: PortAudio.IoStreamRead
        | PortAudio.IoStreamWrite
        | PortAudio.IoStreamDuplex
        | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            device: { type: "string", pos: 0, val: "",   match: /^(.+?):(.+)$/ },
            mode:   { type: "string", pos: 1, val: "rw", match: /^(?:r|w|rw)$/ }
        })

        /*  declare node input/output format  */
        if (this.params.mode === "rw") {
            this.input  = "audio"
            this.output = "audio"
        }
        else if (this.params.mode === "r") {
            this.input  = "none"
            this.output = "audio"
        }
        else if (this.params.mode === "w") {
            this.input  = "audio"
            this.output = "none"
        }
    }

    /*  INTERNAL: utility function for finding audio device by pseudo-URL notation  */
    private audioDeviceFromURL (mode: "any" | "r" | "w" | "rw", url: string) {
        /*  parse URL  */
        const m = url.match(/^(.+?):(.+)$/)
        if (m === null)
            throw new Error(`invalid audio device URL "${url}"`)
        const [ , type, name ] = m

        /*  determine audio API  */
        const apis = PortAudio.getHostAPIs()
        const api = apis.HostAPIs.find((api) => api.type.toLowerCase() === type.toLowerCase())
        if (!api)
            throw new Error(`invalid audio API type "${type}"`)

        /*  determine device of audio API  */
        const devices = PortAudio.getDevices()
        for (const device of devices)
            this.log("info", `found audio device "${device.name}" ` +
                `(inputs: ${device.maxInputChannels}, outputs: ${device.maxOutputChannels}`)
        const device = devices.find((device) => {
            return (
                (   (   mode === "r"   && device.maxInputChannels  > 0)
                    || (mode === "w"   && device.maxOutputChannels > 0)
                    || (mode === "rw"  && device.maxInputChannels  > 0 && device.maxOutputChannels > 0)
                    || (mode === "any" && (device.maxInputChannels > 0 || device.maxOutputChannels > 0)))
                && device.name.match(name)
                && device.hostAPIName === api.name
            )
        })
        if (!device)
            throw new Error(`invalid audio device "${name}" (of audio API type "${type}")`)
        return device
    }

    /*  open node  */
    async open () {
        if (this.params.device === "")
            throw new Error("required parameter \"device\" has to be given")

        /*  determine device  */
        const device = this.audioDeviceFromURL(this.params.mode, this.params.device)

        /*  sanity check sample rate compatibility
            (we still do not resample in input/output for simplification reasons)  */
        if (device.defaultSampleRate !== this.config.audioSampleRate)
            throw new Error(`audio device sample rate ${device.defaultSampleRate} is ` +
                `incompatible with required sample rate ${this.config.audioSampleRate}`)

        /*  establish device connection
            Notice: "naudion" actually implements Stream.{Readable,Writable,Duplex}, but
            declares just its sub-interface NodeJS.{Readable,Writable,Duplex}Stream,
            so it is correct to cast it back to Stream.{Readable,Writable,Duplex}  */
        /*  FIXME: the underlying PortAudio outputs verbose/debugging messages  */
        if (this.params.mode === "rw") {
            /*  input/output device  */
            if (device.maxInputChannels === 0)
                throw new Error(`device "${device.id}" does not have any input channels (required by read/write mode)`)
            if (device.maxOutputChannels === 0)
                throw new Error(`device "${device.id}" does not have any output channels (required by read/write mode)`)
            this.log("info", `resolved "${this.params.device}" to duplex device "${device.id}"`)
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

            /*  convert regular stream into object-mode stream  */
            const wrapper1 = utils.createTransformStreamForWritableSide()
            const wrapper2 = utils.createTransformStreamForReadableSide("audio", () => this.timeZero)
            this.stream = Stream.compose(wrapper1, this.stream, wrapper2)
        }
        else if (this.params.mode === "r") {
            /*  input device  */
            if (device.maxInputChannels === 0)
                throw new Error(`device "${device.id}" does not have any input channels (required by read mode)`)
            this.log("info", `resolved "${this.params.device}" to input device "${device.id}"`)
            this.io = PortAudio.AudioIO({
                inOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                }
            })
            this.stream = this.io as unknown as Stream.Readable

            /*  convert regular stream into object-mode stream  */
            const wrapper = utils.createTransformStreamForReadableSide("audio", () => this.timeZero)
            this.stream.pipe(wrapper)
            this.stream = wrapper
        }
        else if (this.params.mode === "w") {
            /*  output device  */
            if (device.maxOutputChannels === 0)
                throw new Error(`device "${device.id}" does not have any output channels (required by write mode)`)
            this.log("info", `resolved "${this.params.device}" to output device "${device.id}"`)
            this.io = PortAudio.AudioIO({
                outOptions: {
                    deviceId:     device.id,
                    channelCount: this.config.audioChannels,
                    sampleRate:   this.config.audioSampleRate,
                    sampleFormat: this.config.audioBitDepth
                }
            })
            this.stream = this.io as unknown as Stream.Writable

            /*  convert regular stream into object-mode stream  */
            const wrapper = utils.createTransformStreamForWritableSide()
            wrapper.pipe(this.stream)
            this.stream = wrapper
        }
        else
            throw new Error(`device "${device.id}" does not have any input or output channels`)

        /*  pass-through PortAudio errors  */
        this.io.on("error", (err) => {
            this.emit("error", err)
        })

        /*  start PortAudio  */
        this.io.start()
    }

    /*  close node  */
    async close () {
        /*  shutdown PortAudio  */
        if (this.io !== null) {
            this.io.quit()
            this.io = null
        }
    }
}

