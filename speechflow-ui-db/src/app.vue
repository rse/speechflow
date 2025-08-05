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
            <div v-bind:key="block.name" v-for="block of info" class="block">
                <div v-if="block.type === 'audio'" class="audio-col">
                    <div class="audio-meter" v-bind:style="{
                        height: (100 * (1 - ((block.value as number) / - 60.0))) + '%'
                    }">
                        <div class="audio-value">
                            {{ (block.value as number).toFixed(1) }}
                        </div>
                    </div>
                </div>
                <div ref="textCol"
                    v-if="block.type === 'text'"
                    class="text-col"
                    v-bind:class="{ intermediate: lastTextBlockKind === 'intermediate' }">
                    <div v-bind:key="value"
                        v-for="value of block.value"
                        class="text-value">
                        {{ value as unknown as string }}
                    </div>
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
            &:has(.audio-col)
                width: 10vw
            &:has(.text-col)
                flex-grow: 1
                flex-shrink: 1
                flex-basis: 0
            .audio-col
                width: 10vw
                height: 100vh
                display: flex
                flex-direction: column
                align-items: flex-end
                justify-content: flex-end
                background-color: var(--color-acc-fg-0)
                .audio-meter
                    width: 100%
                    display: flex
                    flex-direction: column
                    align-items: flex-end
                    justify-content: flex-end
                    background-color: var(--color-acc-fg-3)
                    .audio-value
                        width: 100%
                        font-size: 3vw
                        text-align: center
                        color: var(--color-std-bg-0)
            .text-col
                width: 100%
                height: 100vh
                overflow-x: hidden
                overflow-y: scroll
                .text-value
                    width: calc(100% - 2 * 1.0vw)
                    background-color: var(--color-sig-bg-3)
                    color: var(--color-sig-fg-3)
                    border-radius: 1vw
                    font-size: 2vw
                    padding: 0.5vw 1.0vw
                    margin-bottom: 0.5vw
                    word-wrap: break-word
            .text-col.intermediate
                .text-value:last-child
                    background-color: var(--color-sig-bg-5)
</style>

<script setup lang="ts">
import { defineComponent }   from "vue"
import moment                from "moment"
import ReconnectingWebSocket from "@opensumi/reconnecting-websocket"
import axios                 from "axios"
</script>

<script lang="ts">
type Info = {
    type:  string,
    name:  string,
    value: number | string[]
}
export default defineComponent({
    name: "app",
    components: {
    },
    data: () => ({
        info: [] as Info[],
        lastTextBlockKind: ""
    }),
    created () {
    },
    async mounted () {
        /*  determine API URL  */
        let url = document.location.href
        url = url.replace(/#.+$/, "")
        url = url.replace(/\/[^/]*$/, "")
        url = url + "/api"

        /*  load dashboard configuration  */
        const response = await axios.get(`${url}/dashboard`)
        for (const block of response.data) {
            if (block.type === "audio")
                this.info.push({ type: block.type, name: block.name, value: 0 })
            else if (block.type === "text")
                this.info.push({ type: block.type, name: block.name, value: [] })
        }

        /*  connect to WebSocket API for receiving dashboard information  */
        const ws = new ReconnectingWebSocket(url, [], {
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay:        4000,
            minReconnectionDelay:        1000,
            connectionTimeout:           4000,
            minUptime:                   5000
        })
        ws.addEventListener("open", (ev) => {
        })
        ws.addEventListener("message", (ev) => {
            const event = JSON.parse(ev.data)
            if (event.response !== "DASHBOARD")
                return
            const [ type, name, kind, value ] = event.args
            for (const block of this.info) {
                if (block.type === type && block.name === name) {
                    if (block.type === "audio") {
                        if (kind === "final")
                            block.value = value
                    }
                    else {
                        if (this.lastTextBlockKind === "intermediate") {
                            const arr = block.value as string[]
                            arr[arr.length - 1] = value
                        }
                        else {
                            const arr = block.value as string[]
                            arr.push(value)
                            block.value = arr.slice(-20)
                        }
                        this.lastTextBlockKind = kind
                        for (const textCol of this.$refs.textCol as HTMLDivElement[]) {
                            console.log("FUCK", textCol, textCol.scrollTop, textCol.scrollHeight)
                            textCol.scrollTop = textCol.scrollHeight
                        }
                    }
                }
            }
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

