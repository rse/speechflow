<!--
**
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
**
-->

<template>
    <div class="app">
        <div class="block">
            <div class="text-col">
                <div v-bind:key="chunk.text"
                    v-for="(chunk, idx) of text"
                    class="text-value"
                    v-bind:class="{ intermediate: chunk.kind === 'intermediate' }">
                    {{ chunk.text }}
                    <span class="cursor" v-if="idx === (chunk.text.length - 1) && chunk.kind === 'intermediate'">
                        <spinner-grid class="spinner-grid" size="32"/>
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>

<style lang="stylus">
.app
    position: relative
    width:   100vw
    height:  100vh
    margin:  0
    padding: 0
    display: flex
    flex-direction: column
    justify-content: center
    align-items: center
    .block
        height: auto
        width: 80vw
        position: absolute
        bottom: 5vh
        .text-col
            width: 100%
            height: 100%
            overflow-x: hidden
            overflow-y: scroll
            display: flex
            flex-direction: column
            align-items: flex-end
            justify-content: flex-end
            padding-top: 1vw
            .text-value
                width: calc(100% - 2 * 1.0vw)
                background-color: #000000c0
                color: #ffffff
                border-radius: 1vw
                font-size: 2vw
                padding: 0.5vw 1.0vw
                margin-bottom: 0.5vw
                overflow-wrap: break-word
                .cursor
                    display: inline-block
                    margin-left: 10px
                &.intermediate:last-child
                    background-color: #666666c0
</style>

<script setup lang="ts">
import { defineComponent }    from "vue"
import { VueSpinnerGrid }     from "vue3-spinners"
import { DateTime, Duration } from "luxon"
import ReconnectingWebSocket  from "@opensumi/reconnecting-websocket"
</script>

<script lang="ts">
type TextChunk = {
    timestamp:      DateTime,
    kind:           "intermediate" | "final",
    text:           string
}
type SpeechFlowChunk = {
    timestampStart: Duration,
    timestampEnd:   Duration,
    kind:           "intermediate" | "final",
    type:           "text",
    payload:        string,
    meta:           Map<string, any>
}
export default defineComponent({
    name: "app",
    components: {
        "spinner-grid":  VueSpinnerGrid
    },
    data: () => ({
        text: [] as TextChunk[],
        lastTextBlockKind: ""
    }),
    async mounted () {
        /*  determine API URL  */
        const url = new URL("/api", document.location.href).toString()

        /*  cleanup still displayed text chunks  */
        setInterval(() => {
            if (this.text.length > 0 && this.text[0].timestamp < DateTime.now().minus({ seconds: 8 }))
                this.text = this.text.slice(1)
        }, 500)

        /*  connect to WebSocket API for receiving dashboard information  */
        const ws = new ReconnectingWebSocket(url, [], {
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay:        4000,
            minReconnectionDelay:        1000,
            connectionTimeout:           4000,
            minUptime:                   5000
        })
        ws.addEventListener("open", (ev) => {
            this.log("INFO", "WebSocket connection established")
        })
        ws.addEventListener("close", (ev) => {
            this.log("INFO", "WebSocket connection destroyed")
        })
        ws.addEventListener("message", (ev) => {
            let chunk: SpeechFlowChunk
            try {
                chunk = JSON.parse(ev.data)
            }
            catch (error) {
                this.log("ERROR", "Failed to parse WebSocket message", { error, data: ev.data })
                return
            }
            if (this.text.length > 0 && this.text[this.text.length - 1].kind === "intermediate")
                this.text[this.text.length - 1] =
                    { text: chunk.payload, kind: chunk.kind, timestamp: DateTime.now() }
            else {
                this.text.push({ text: chunk.payload, kind: chunk.kind, timestamp: DateTime.now() })
                this.text = this.text.slice(-2)
            }
        })
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
        }
    }
})
</script>

