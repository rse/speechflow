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
import * as util        from "./speechflow-util"

/*  SpeechFlow node for device access  */
export default class SpeechFlowNodeXIODevice extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-device"

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
            mode:   { type: "string", pos: 1, val: "rw", match: /^(?:r|w|rw)$/ },
            chunk:  { type: "number", pos: 2, val: 200,  match: (n: number) => n >= 10 && n <= 1000 }
        })

        /*  sanity check parameters  */
        if (this.params.device === "")
            throw new Error("required parameter \"device\" has to be given")

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
                `(inputs: ${device.maxInputChannels}, outputs: ${device.maxOutputChannels})`)
        const device = devices.find((device) => (
            (   (   mode === "r"   && device.maxInputChannels  > 0)
                || (mode === "w"   && device.maxOutputChannels > 0)
                || (mode === "rw"  && device.maxInputChannels  > 0 && device.maxOutputChannels > 0)
                || (mode === "any" && (device.maxInputChannels > 0 || device.maxOutputChannels > 0)))
            && device.name.match(name)
            && device.hostAPIName === api.name
        ))
        if (!device)
            throw new Error(`invalid audio device "${name}" (of audio API type "${type}")`)
        return device
    }

    /*  NOTICE: "naudion" actually implements Stream.{Readable,Writable,Duplex}, but
        declares just its sub-interface NodeJS.{Readable,Writable,Duplex}Stream,
        so it is correct to cast it back to Stream.{Readable,Writable,Duplex}
        in the following device stream setup functions!  */

    /*  INTERNAL: setup duplex stream  */
    private setupDuplexStream (device: PortAudio.DeviceInfo, highwaterMark: number) {
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
                sampleFormat: this.config.audioBitDepth,
                highwaterMark
            },
            outOptions: {
                deviceId:     device.id,
                channelCount: this.config.audioChannels,
                sampleRate:   this.config.audioSampleRate,
                sampleFormat: this.config.audioBitDepth,
                highwaterMark
            }
        })
        this.stream = this.io as unknown as Stream.Duplex

        /*  convert regular stream into object-mode stream  */
        const wrapper1 = util.createTransformStreamForWritableSide("audio", 1)
        const wrapper2 = util.createTransformStreamForReadableSide("audio", () => this.timeZero, highwaterMark)
        this.stream = Stream.compose(wrapper1, this.stream, wrapper2)
    }

    /*  INTERNAL: setup input stream  */
    private setupInputStream (device: PortAudio.DeviceInfo, highwaterMark: number) {
        if (device.maxInputChannels === 0)
            throw new Error(`device "${device.id}" does not have any input channels (required by read mode)`)
        this.log("info", `resolved "${this.params.device}" to input device "${device.id}"`)
        this.io = PortAudio.AudioIO({
            inOptions: {
                deviceId:      device.id,
                channelCount:  this.config.audioChannels,
                sampleRate:    this.config.audioSampleRate,
                sampleFormat:  this.config.audioBitDepth,
                highwaterMark
            }
        })
        this.stream = this.io as unknown as Stream.Readable

        /*  convert regular stream into object-mode stream  */
        const wrapper = util.createTransformStreamForReadableSide("audio", () => this.timeZero, highwaterMark)
        this.stream = Stream.compose(this.stream, wrapper)
    }

    /*  INTERNAL: setup output stream  */
    private setupOutputStream (device: PortAudio.DeviceInfo, highwaterMark: number) {
        if (device.maxOutputChannels === 0)
            throw new Error(`device "${device.id}" does not have any output channels (required by write mode)`)
        this.log("info", `resolved "${this.params.device}" to output device "${device.id}"`)
        this.io = PortAudio.AudioIO({
            outOptions: {
                deviceId:     device.id,
                channelCount: this.config.audioChannels,
                sampleRate:   this.config.audioSampleRate,
                sampleFormat: this.config.audioBitDepth,
                highwaterMark
            }
        })
        this.stream = this.io as unknown as Stream.Writable

        /*  convert regular stream into object-mode stream  */
        const wrapper = util.createTransformStreamForWritableSide("audio", 1)
        this.stream = Stream.compose(wrapper, this.stream)
    }

    /*  open node  */
    async open () {
        /*  determine device  */
        const device = this.audioDeviceFromURL(this.params.mode, this.params.device)

        /*  sanity check sample rate compatibility
            (we still do not resample in input/output for simplification reasons)  */
        if (device.defaultSampleRate !== this.config.audioSampleRate)
            throw new Error(`audio device sample rate ${device.defaultSampleRate} is ` +
                `incompatible with required sample rate ${this.config.audioSampleRate}`)

        /*  determine how many bytes we need per chunk when
            the chunk should be the requested duration  */
        const highwaterMark = (
            this.config.audioSampleRate *
            (this.config.audioBitDepth / 8)
        ) / (1000 / this.params.chunk)

        /*  establish device stream  */
        if (this.params.mode === "rw")
            this.setupDuplexStream(device, highwaterMark)
        else if (this.params.mode === "r")
            this.setupInputStream(device, highwaterMark)
        else if (this.params.mode === "w")
            this.setupOutputStream(device, highwaterMark)

        /*  pass-through PortAudio errors  */
        this.io!.on("error", (err) => {
            this.emit("error", err)
            this.stream?.emit("error", err)
        })

        /*  start PortAudio  */
        this.io!.start()
    }

    /*  close node  */
    async close () {
        /*  shutdown PortAudio  */
        if (this.io !== null) {
            const catchHandler = (err: unknown) => {
                const error = util.ensureError(err)
                if (!error.message.match(/AudioIO Quit expects 1 argument/))
                    throw error
            }
            await Promise.race([
                util.timeoutPromise(2 * 1000, "PortAudio abort timeout"),
                new Promise<void>((resolve) => {
                    this.io!.abort(() => {
                        resolve()
                    })
                }).catch(catchHandler)
            ])
            await Promise.race([
                util.timeoutPromise(2 * 1000, "PortAudio quit timeout"),
                new Promise<void>((resolve) => {
                    this.io!.quit(() => {
                        resolve()
                    })
                }).catch(catchHandler)
            ])
            this.io = null
        }
    }
}

