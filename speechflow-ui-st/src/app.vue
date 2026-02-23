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
                <span class="chunk"
                    v-for="(chunk, cidx) of text"
                    v-bind:key="`chunk-${chunk.id}`"
                    v-bind:ref="`chunk-${chunk.id}`">
                    <span class="chunk-frag"
                        v-for="(frag, fidx) of chunk.text"
                        v-bind:key="`chunk-${chunk.id}-frag-${fidx}`">
                        <span
                            class="chunk-bg"
                            v-bind:class="{ intermediate: chunk.kind === 'intermediate', removed: chunk.removed }">
                            {{ frag }}
                        </span>
                        <span
                            class="chunk-fg"
                            v-bind:class="{ intermediate: chunk.kind === 'intermediate', removed: chunk.removed }">
                            {{ frag }}
                        </span>
                    </span>
                    <span class="cursor" v-if="cidx === (text.length - 1) && chunk.kind === 'intermediate'">
                        <spinner-grid class="spinner-grid" size="30"/>
                    </span>
                </span>
            </div>
        </div>
    </div>
</template>

<style lang="stylus">
/*  entire app  */
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

    /*  rendering area  */
    .area
        height: auto
        min-height: 30vh
        max-height: 60vh
        width: 75vw
        position: absolute
        bottom: 4vh
        mask: linear-gradient(to bottom, transparent 0%, black 50%)
        overflow-x: hidden
        overflow-y: hidden
        display: flex
        flex-direction: column
        align-items: center
        justify-content: flex-end

        /*  content block  */
        .block
            display: block
            text-align: left
            width: 100%
            overflow-wrap: break-word

            /*  content chunk  */
            .chunk
                .chunk-frag
                    display: inline-block
                    position: relative
                    .chunk-fg
                        z-index: 20
                        color: #ffffff
                        -webkit-text-stroke: 4px #00000000
                        font-size: 2.0vw
                        font-weight: 600
                        line-height: 1.3
                        padding-left:  0.20vw
                        padding-right: 0.20vw
                        &.intermediate:last-child
                            color: #ffe0c0
                        &.removed
                            opacity: 0
                    .chunk-bg
                        z-index: -10
                        position: absolute
                        color: #000000
                        -webkit-text-stroke: 5px #000000e0
                        font-size: 2.0vw
                        font-weight: 600
                        line-height: 1.3
                        padding-left:  0.20vw
                        padding-right: 0.20vw
                        &.intermediate:last-child
                            color: #ffe0c0
                        &.removed
                            opacity: 0
                .cursor
                    position: relative
                    display: inline-block
                    margin-left: 10px
                    margin-right: 10px
                    top: -7px
                    color: #ffe0c0
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
    text:           string[],
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
        /*  determine API URLs  */
        const urlHTTP = new URL("/api", document.location.href)
        const urlWS   = new URL("/api", document.location.href)
        urlWS.protocol = (urlHTTP.protocol === "https:" ? "wss:" : "ws:")

        /*  optically remove outdated text chunks  */
        this.cleanupIntervalId = setInterval(() => {
            for (const chunk of this.text) {
                if (chunk.timestamp < DateTime.now().minus({ seconds: 10 }) && !chunk.removing && !chunk.removed) {
                    const el = this.$refs[`chunk-${chunk.id}`] as HTMLSpanElement
                    if (!el)
                        continue

                    /*  start removing  */
                    chunk.removing = true
                    chunk.removed  = false
                    anime.animate(el, {
                        opacity:    [ 1, 0 ],
                        duration:   2000,
                        easing:     "easeOutQuad",
                        onComplete: () => {
                            /*  end removing  */
                            chunk.removing = false
                            chunk.removed  = true
                        }
                    })
                }
            }
        }, 500)

        /*  connect to WebSocket API for receiving dashboard information  */
        const ws = new ReconnectingWebSocket(urlWS.toString(), [], {
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay:        4000,
            minReconnectionDelay:        1000,
            connectionTimeout:           4000,
            minUptime:                   5000
        })
        ws.addEventListener("error", (ev) => {
            this.log("ERROR", `WebSocket error: ${ev.message}`)
        })

        /*  track connection open/close  */
        ws.addEventListener("open", (ev) => {
            this.log("INFO", "WebSocket connection established")
        })
        ws.addEventListener("close", (ev) => {
            this.log("INFO", "WebSocket connection destroyed")
        })

        /*  receive messages  */
        ws.addEventListener("message", (ev) => {
            /*  parse message  */
            let chunk: SpeechFlowChunk
            try {
                chunk = JSON.parse(ev.data)
            }
            catch (error) {
                this.log("ERROR", "Failed to parse WebSocket message", { error, data: ev.data })
                return
            }

            /*  process text chunks  */
            if (this.text.length > 0 && this.text[this.text.length - 1].kind === "intermediate") {
                /*  override previous intermediate text chunk
                    with either another intermediate one or a final one  */
                const lastChunk = this.text[this.text.length - 1]
                lastChunk.text      = chunk.payload.split(/\s+/),
                lastChunk.kind      = chunk.kind
                lastChunk.timestamp = DateTime.now()
            }
            else {
                /*  remove content in case all chunks were removed
                    (this way new next chunk starts at the left edge again
                    and the overall memory consumption is reduced)  */
                if (this.text.every((chunk) => chunk.removed))
                    this.text = []

                /*  add new text chunk  */
                this.text.push({
                    id:        `chunk-${this.chunkIdCounter++}`,
                    text:      chunk.payload.split(/\s+/),
                    kind:      chunk.kind,
                    timestamp: DateTime.now(),
                    removing:  false,
                    removed:   false
                })
            }

            /*  ensure we always scrolled the chunks inside the block to the bottom  */
            this.$nextTick(() => {
                const block = this.$refs.block as HTMLDivElement
                block.scrollTop = block.scrollHeight
            })
        })
    },
    beforeUnmount () {
        /*  cleanup  */
        if (this.cleanupIntervalId !== null) {
            clearInterval(this.cleanupIntervalId)
            this.cleanupIntervalId = null
        }
    },
    methods: {
        /*  helper function for console logging  */
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

