/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import PortAudio from "@gpeng/naudiodon"

export default class SpeechFlowUtil {
    static audioDeviceFromURL (mode: "any" | "r" | "w" | "rw", url: string) {
        const m = url.match(/^(.+?):(.+)$/)
        if (m === null)
            throw new Error(`invalid audio device URL "${url}"`)
        const [ , type, name ] = m
        const apis = PortAudio.getHostAPIs()
        const api = apis.HostAPIs.find((api) => api.type.toLowerCase() === type.toLowerCase())
        if (!api)
            throw new Error(`invalid audio device type "${type}"`)
        const devices = PortAudio.getDevices()
        console.log(devices)
        const device = devices.find((device) => {
            return (
                (   (   mode === "r"   && device.maxInputChannels  > 0)
                    || (mode === "w"   && device.maxOutputChannels > 0)
                    || (mode === "rw"  && device.maxInputChannels  > 0 && device.maxOutputChannels > 0)
                    || (mode === "any" && (device.maxInputChannels  > 0 || device.maxOutputChannels > 0)))
                && device.name.match(name)
                && device.hostAPIName === api.name
            )
        })
        if (!device)
            throw new Error(`invalid audio device name "${name}" (of audio type "${type}")`)
        return device
    }
}

