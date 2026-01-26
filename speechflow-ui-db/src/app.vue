<!--
**
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
**
-->

<template>
    <div class="app">
        <div class="dashboard">
            <div v-bind:key="block.id" v-for="block of info" class="block">
                <div class="block-content">
                    <div v-if="block.type === 'audio'" class="audio-col">
                        <div class="audio-meter" v-bind:style="{
                            height: (100 * (1 - ((block.value as number) / - 60.0))) + '%'
                        }">
                            <div class="audio-value">
                                {{ (block.value as number).toFixed(1) }}
                                <div class="audio-unit">LUFS-M</div>
                            </div>
                        </div>
                    </div>
                    <div ref="textCol"
                        v-if="block.type === 'text'"
                        class="text-col"
                        v-bind:class="{ intermediate: block.lastKind === 'intermediate' }">
                        <div v-bind:key="value"
                            v-for="value of block.value"
                            class="text-value">
                            {{ value }}
                        </div>
                    </div>
                </div>
                <div class="block-name">
                    {{ block.name }}
                </div>
            </div>
        </div>
    </div>
</template>

<style lang="stylus">
.app
    position: relative
    width:   calc(100vw - 2 * 1vw)
    height:  calc(100vh - 2 * 1vw)
    margin:  0
    padding: 1vw
    display: flex
    flex-direction: column
    justify-content: center
    align-items: center
    .dashboard
        height: 100%
        width: 100%
        display: flex
        flex-direction: row
        align-items: center
        justify-content: center
        .block
            height: calc(100% - 0.5vw)
            margin-right: 0.5vw
            flex-direction: column
            align-items: flex-end
            justify-content: flex-end
            &:last-child
                margin-right: 0
            &:has(.audio-col)
                width: 10vw
            &:has(.text-col)
                flex-grow: 1
                flex-shrink: 1
                flex-basis: 0
                min-width: 0
            .block-name
                width: 100%
                height: 2.5vw
                text-align: center
                background-color: var(--color-std-bg-3)
                color: var(--color-std-fg-3)
                font-size: 1.5vw
                margin-top: 0.5vw
                border-radius: 0.5vw
            .block-content
                background-color: var(--color-std-bg-3)
                height: calc(100% - 3.0vw)
                border-radius: 0.5vw
                overflow: hidden
                .audio-col
                    width: 10vw
                    height: 100%
                    display: flex
                    flex-direction: column
                    align-items: flex-end
                    justify-content: flex-end
                    background-color: var(--color-std-bg-3)
                    .audio-meter
                        width: 100%
                        display: flex
                        flex-direction: column
                        align-items: flex-end
                        justify-content: flex-end
                        background-color: var(--color-acc-bg-5)
                        .audio-value
                            width: 100%
                            font-size: 2.5vw
                            text-align: center
                            color: var(--color-std-fg-5)
                            .audio-unit
                                font-size: 1.5vw
                                margin-top: -0.5vw
                                margin-bottom: 0.5vw
                .text-col
                    width: 100%
                    height: 100%
                    overflow-x: hidden
                    overflow-y: scroll
                    display: flex
                    flex-direction: column
                    align-items: flex-end
                    justify-content: flex-end
                    .text-value
                        width: calc(100% - 2 * 1.0vw)
                        background-color: var(--color-acc-bg-3)
                        color: var(--color-acc-fg-5)
                        border-radius: 0.5vw
                        font-size: 1.5vw
                        padding: 0.5vw 1.0vw
                        margin-top: 0.5vw
                        overflow-wrap: break-word
                .text-col.intermediate
                    .text-value:last-child
                        background-color: var(--color-sig-bg-3)
                        color: var(--color-sig-fg-5)
</style>

<script setup lang="ts">
import { defineComponent }   from "vue"
import { DateTime }          from "luxon"
import ReconnectingWebSocket from "@opensumi/reconnecting-websocket"
import axios                 from "axios"
</script>

<script lang="ts">
/*  LUFS value with timestamp for temporal averaging  */
interface LufsEntry {
    value: number,
    time:  number
}

/*  duration for LUFS-M display averaging window (ms)  */
const lufsWindowMs = 400

/*  type of a single text or audio block  */
type Info = {
    type:        string,
    id:          string,
    name:        string,
    value:       number | string[],
    lastKind:    string,
    lufsBuffer?: LufsEntry[]
}

/*  type of a websocket event message  */
interface WebSocketEvent {
    response: string,
    args: [ string, string, string, number | string ]
}

/*  the Vue component  */
export default defineComponent({
    name: "app",
    data: () => ({
        info:      [] as Info[],
        ws:        null as ReconnectingWebSocket | null,
        lufsTimer: null as ReturnType<typeof setInterval> | null
    }),
    async mounted () {
        /*  determine API URLs  */
        const urlHTTP = new URL("/api", document.location.href)
        const urlWS   = new URL("/api", document.location.href)
        urlWS.protocol = (urlHTTP.protocol === "https:" ? "wss:" : "ws:")

        /*  load dashboard configuration  */
        const response = await axios.get(`${urlHTTP.toString()}/dashboard`)
        for (const block of response.data) {
            if (block.type === "audio")
                this.info.push({ type: block.type, id: block.id, name: block.name, value: -60, lastKind: "", lufsBuffer: [] })
            else if (block.type === "text")
                this.info.push({ type: block.type, id: block.id, name: block.name, value: [], lastKind: "" })
        }

        /*  start timer to update LUFS display values from buffered entries  */
        this.lufsTimer = setInterval(() => {
            this.updateLufsDisplayValues()
        }, 50)

        /*  connect to WebSocket API for receiving dashboard information  */
        this.ws = new ReconnectingWebSocket(urlWS.toString(), [], {
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay:        4000,
            minReconnectionDelay:        1000,
            connectionTimeout:           4000,
            minUptime:                   5000
        })
        this.ws.addEventListener("error", (ev) => {
            this.log("ERROR", `WebSocket error: ${ev.message}`)
        })

        /*  track connection open/close  */
        this.ws.addEventListener("open", (ev) => {
            this.log("INFO", "WebSocket connection established")
        })
        this.ws.addEventListener("close", (ev) => {
            this.log("INFO", "WebSocket connection destroyed")

            /*  reset meters and clear LUFS buffers  */
            for (const block of this.info) {
                if (block.type === "audio" && block.lufsBuffer !== undefined) {
                    block.value = -60
                    block.lufsBuffer.length = 0
                }
            }
        })

        /*  receive messages  */
        this.ws.addEventListener("message", (ev) => {
            let event: WebSocketEvent
            try {
                event = JSON.parse(ev.data)
            }
            catch (error) {
                this.log("ERROR", "Failed to parse WebSocket message", { error, data: ev.data })
                return
            }
            if (event.response !== "DASHBOARD")
                return

            /*  extract dashboard update parameters: [ type, id, kind, value ]  */
            const [ type, id, kind, value ] = event.args
            for (const block of this.info) {
                if (block.type === type && block.id === id) {
                    if (block.type === "audio" && block.lufsBuffer !== undefined) {
                        /*  buffer LUFS values for temporal averaging  */
                        if (kind === "final" && typeof value === "number")
                            block.lufsBuffer.push({ value, time: Date.now() })
                    }
                    else {
                        if (typeof value === "string") {
                            const arr = block.value as string[]
                            if (block.lastKind === "intermediate")
                                arr[arr.length - 1] = value
                            else {
                                arr.push(value)
                                block.value = arr.slice(-20)
                            }
                        }
                        block.lastKind = kind
                        this.$nextTick(() => {
                            for (const textCol of this.$refs.textCol as HTMLDivElement[])
                                textCol.scrollTop = textCol.scrollHeight
                        })
                    }
                }
            }
        })
    },
    beforeUnmount () {
        if (this.lufsTimer) {
            clearInterval(this.lufsTimer)
            this.lufsTimer = null
        }
        if (this.ws) {
            this.ws.close()
            this.ws = null
        }
    },
    methods: {
        log (level: string, msg: string, data: { [ key: string ]: any } | null = null) {
            const timestamp = DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss.SSS")
            let output = `${timestamp} [${level}]: ${msg}`
            if (data !== null)
                output += ` (${Object.keys(data)
                    .map((key) => key + ": " + JSON.stringify(data[key]))
                    .join(", ")
                })`
            console.log(output)
        },

        /*  update LUFS display values from buffered entries  */
        updateLufsDisplayValues () {
            const now = Date.now()
            for (const block of this.info) {
                if (block.type !== "audio" || block.lufsBuffer === undefined)
                    continue

                /*  remove entries older than the window duration  */
                const buffer = block.lufsBuffer
                while (buffer.length > 0 && (now - buffer[0].time) > lufsWindowMs)
                    buffer.shift()

                /*  calculate average of remaining entries or fall back to silence  */
                if (buffer.length > 0) {
                    const sum = buffer.reduce((acc, entry) => acc + entry.value, 0)
                    block.value = sum / buffer.length
                }
                else
                    block.value = -60
            }
        }
    }
})
</script>

