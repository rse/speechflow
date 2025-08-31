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
            <div class="text-col"
                v-bind:class="{ intermediate: lastTextBlockKind === 'intermediate' }">
                <div v-bind:key="value"
                    v-for="(value, idx) of text"
                    class="text-value">
                    {{ value as string }}
                    <span class="cursor" v-if="idx === (text.length - 1) && lastTextBlockKind === 'intermediate'">
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
        height: 20vh
        width: 80vw
        position: absolute
        bottom: 1vh
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
        .text-col.intermediate
            .text-value:last-child
                background-color: #666666c0
</style>

<script setup lang="ts">
import { defineComponent }   from "vue"
import { VueSpinnerGrid }    from "vue3-spinners"
import moment                from "moment"
import { Duration }          from "luxon"
import ReconnectingWebSocket from "@opensumi/reconnecting-websocket"
</script>

<script lang="ts">
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
        text: [] as string[],
        lastTextBlockKind: ""
    }),
    async mounted () {
        /*  determine API URL  */
        let url = document.location.href
        url = url.replace(/#.+$/, "")
        url = url.replace(/\/[^/]*$/, "")
        url = url + "/api"

        /*  connect to WebSocket API for receiving dashboard information  */
        const ws = new ReconnectingWebSocket(url, [], {
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay:        4000,
            minReconnectionDelay:        1000,
            connectionTimeout:           4000,
            minUptime:                   5000
        })
        ws.addEventListener("message", (ev) => {
            const chunk = JSON.parse(ev.data) as SpeechFlowChunk
            if (this.lastTextBlockKind === "intermediate")
                this.text[this.text.length - 1] = chunk.payload
            else {
                this.text.push(chunk.payload)
                this.text = this.text.slice(-2)
            }
            this.lastTextBlockKind = chunk.kind
        })
    },
    methods: {
        log (level: string, msg: string, data: { [ key: string ]: any } | null = null) {
            const timestamp = moment().format("YYYY-MM-DD hh:mm:ss.SSS")
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

