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
                                <div class="audio-unit">LUFS-S</div>
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
                            {{ value as string }}
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
import moment                from "moment"
import ReconnectingWebSocket from "@opensumi/reconnecting-websocket"
import axios                 from "axios"
</script>

<script lang="ts">
type Info = {
    type:     string,
    id:       string,
    name:     string,
    value:    number | string[],
    lastKind: string
}
export default defineComponent({
    name: "app",
    components: {
    },
    data: () => ({
        info: [] as Info[]
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
                this.info.push({ type: block.type, id: block.id, name: block.name, value: 0, lastKind: "" })
            else if (block.type === "text")
                this.info.push({ type: block.type, id: block.id, name: block.name, value: [], lastKind: "" })
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
            const [ type, id, kind, value ] = event.args
            for (const block of this.info) {
                if (block.type === type && block.id === id) {
                    if (block.type === "audio") {
                        if (kind === "final")
                            block.value = value
                    }
                    else {
                        if (block.lastKind === "intermediate") {
                            const arr = block.value as string[]
                            arr[arr.length - 1] = value
                        }
                        else {
                            const arr = block.value as string[]
                            arr.push(value)
                            block.value = arr.slice(-20)
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

