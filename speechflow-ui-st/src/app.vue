<!--
**
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
**
-->

<template>
    <div class="app">
        <div class="area">
            <div class="block" ref="block">
                <span v-bind:key="chunk.id"
                    v-for="(chunk, idx) of text"
                    class="chunk"
                    v-bind:class="{ intermediate: chunk.kind === 'intermediate', removed: chunk.removed }"
                    v-bind:ref="`chunk-${chunk.id}`">
                    {{ chunk.text }}
                    <span class="cursor" v-if="idx === (text.length - 1) && chunk.kind === 'intermediate'">
                        <spinner-grid class="spinner-grid" size="32"/>
                    </span>
                </span>
            </div>
        </div>
    </div>
</template>

<style lang="stylus">
.app
    background-color: blue
    position: relative
    width:   100vw
    height:  100vh
    margin:  0
    padding: 0
    display: flex
    flex-direction: column
    justify-content: center
    align-items: center
    .area
        height: auto
        min-height: 30vh
        max-height: 60vh
        width: 60vw
        position: absolute
        bottom: 5vh
        mask: linear-gradient(to bottom, transparent 0%, black 30%)
        overflow-x: hidden
        overflow-y: hidden
        display: flex
        flex-direction: column
        align-items: center
        justify-content: flex-end
        .block
            display: block
            text-align: left
            width: 100%
            overflow-wrap: break-word
            .chunk
                color: #dddddd
                text-shadow: 0.20vw 0.20vw 0.20vw #000000
                border-radius: 1vw
                font-size: 2vw
                margin-right: 0.5vw
                .cursor
                    display: inline-block
                    margin-left: 10px
                &.intermediate:last-child
                    color: #ffffff
                &.removed
                    opacity: 0
</style>

<script setup lang="ts">
import { defineComponent }    from "vue"
import { VueSpinnerGrid }     from "vue3-spinners"
import { DateTime, Duration } from "luxon"
import ReconnectingWebSocket  from "@opensumi/reconnecting-websocket"
import * as anime             from "animejs"
</script>

<script lang="ts">
type TextChunk = {
    id:             string,
    timestamp:      DateTime,
    kind:           "intermediate" | "final",
    text:           string,
    removing:       boolean,
    removed:        boolean
}
type SpeechFlowChunk = {
    timestampStart: Duration,
    timestampEnd:   Duration,
    kind:           "intermediate" | "final",
    type:           "text",
    payload:        string,
    meta:           Map<string, unknown>
}
export default defineComponent({
    name: "app",
    components: {
        "spinner-grid":  VueSpinnerGrid
    },
    data: () => ({
        text: [] as TextChunk[],
        chunkIdCounter: 0,
        cleanupIntervalId: null as ReturnType<typeof setInterval> | null
    }),
    async mounted () {
        /*  determine API URL  */
        const url = new URL("/api", document.location.href).toString()

        /*  cleanup still displayed text chunks  */
        this.cleanupIntervalId = setInterval(() => {
            for (const chunk of this.text) {
                if (chunk.timestamp < DateTime.now().minus({ seconds: 10 }) && !chunk.removing && !chunk.removed) {
                    const el = this.$refs[`chunk-${chunk.id}`] as HTMLSpanElement
                    if (!el)
                        continue
                    chunk.removing = true
                    chunk.removed  = false
                    anime.animate(el, {
                        opacity:    [ 1, 0 ],
                        duration:   2000,
                        easing:     "easeOutQuad",
                        onComplete: () => {
                            chunk.removing = false
                            chunk.removed  = true
                        }
                    })
                }
            }
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
            if (this.text.length > 0 && this.text[this.text.length - 1].kind === "intermediate") {
                const lastChunk = this.text[this.text.length - 1]
                lastChunk.text      = chunk.payload
                lastChunk.kind      = chunk.kind
                lastChunk.timestamp = DateTime.now()
            }
            else {
                if (this.text.every((chunk) => chunk.removed))
                    this.text = []
                this.text.push({
                    id:        `chunk-${this.chunkIdCounter++}`,
                    text:      chunk.payload,
                    kind:      chunk.kind,
                    timestamp: DateTime.now(),
                    removing:  false,
                    removed:   false
                })
            }
            this.$nextTick(() => {
                const block = this.$refs.block as HTMLDivElement
                block.scrollTop = block.scrollHeight
            })
        })
    },
    beforeUnmount () {
        if (this.cleanupIntervalId !== null) {
            clearInterval(this.cleanupIntervalId)
            this.cleanupIntervalId = null
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
        }
    }
})
</script>

