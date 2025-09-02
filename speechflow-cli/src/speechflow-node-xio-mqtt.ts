/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import MQTT   from "mqtt"
import UUID   from "pure-uuid"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as utils                          from "./speechflow-utils"

/*  SpeechFlow node for MQTT networking  */
export default class SpeechFlowNodeXIOMQTT extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-mqtt"

    /*  internal state  */
    private broker: MQTT.MqttClient | null = null
    private clientId: string = (new UUID(1)).format()
    private chunkQueue: utils.SingleQueue<SpeechFlowChunk> | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            url:        { type: "string", pos: 0, val: "",     match: /^(?:|(?:ws|mqtt):\/\/(.+?):(\d+)(?:\/.*)?)$/ },
            username:   { type: "string", pos: 1, val: "",     match: /^.+$/ },
            password:   { type: "string", pos: 2, val: "",     match: /^.+$/ },
            topicRead:  { type: "string", pos: 3, val: "",     match: /^.+$/ },
            topicWrite: { type: "string", pos: 4, val: "",     match: /^.+$/ },
            mode:       { type: "string", pos: 5, val: "w",    match: /^(?:r|w|rw)$/ },
            type:       { type: "string", pos: 6, val: "text", match: /^(?:audio|text)$/ }
        })

        /*  declare node input/output format  */
        if (this.params.mode === "rw") {
            this.input  = this.params.type
            this.output = this.params.type
        }
        else if (this.params.mode === "r") {
            this.input  = "none"
            this.output = this.params.type
        }
        else if (this.params.mode === "w") {
            this.input  = this.params.type
            this.output = "none"
        }
    }

    /*  open node  */
    async open () {
        /*  logical parameter sanity check  */
        if (this.params.url === "")
            throw new Error("required parameter \"url\" has to be given")
        if ((this.params.mode === "w" || this.params.mode === "rw") && this.params.topicWrite === "")
            throw new Error("writing to MQTT requires a topicWrite parameter")
        if ((this.params.mode === "r" || this.params.mode === "rw") && this.params.topicRead === "")
            throw new Error("reading from MQTT requires a topicRead parameter")
        if (this.params.username !== "" && this.params.password === "")
            throw new Error("username provided but password is missing")
        if (this.params.username === "" && this.params.password !== "")
            throw new Error("password provided but username is missing")

        /*  connect remotely to a MQTT broker  */
        this.broker = MQTT.connect(this.params.url, {
            protocolId:      "MQTT",
            protocolVersion: 5,
            username:        this.params.username,
            password:        this.params.password,
            clientId:        this.clientId,
            clean:           true,
            resubscribe:     true,
            keepalive:       60,        /* 60s */
            reconnectPeriod: 2  * 1000, /*  2s */
            connectTimeout:  30 * 1000  /* 30s */
        })
        this.broker.on("error", (error: Error) => {
            this.log("error", `error on MQTT ${this.params.url}: ${error.message}`)
        })
        this.broker.on("connect", (packet: MQTT.IConnackPacket) => {
            this.log("info", `connection opened to MQTT ${this.params.url}`)
            if (this.params.mode !== "w" && !packet.sessionPresent)
                this.broker!.subscribe([ this.params.topicRead ], (err) => {
                    if (err)
                        this.log("warning", `failed to subscribe to MQTT topic "${this.params.topicRead}": ${err.message}`)
                })
        })
        this.broker.on("reconnect", () => {
            this.log("info", `connection re-opened to MQTT ${this.params.url}`)
        })
        this.broker.on("disconnect", (packet: MQTT.IDisconnectPacket) => {
            this.log("info", `connection closed to MQTT ${this.params.url}`)
        })
        this.chunkQueue = new utils.SingleQueue<SpeechFlowChunk>()
        this.broker.on("message", (topic: string, payload: Buffer, packet: MQTT.IPublishPacket) => {
            if (topic !== this.params.topicRead || this.params.mode === "w")
                return
            try {
                const chunk = utils.streamChunkDecode(payload)
                this.chunkQueue!.write(chunk)
            }
            catch (_err: any) {
                this.log("warning", `received invalid CBOR chunk from MQTT ${this.params.url}`)
            }
        })
        const self = this
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.params.mode === "r")
                    callback(new Error("write operation on read-only node"))
                else if (chunk.type !== self.params.type)
                    callback(new Error(`written chunk is not of ${self.params.type} type`))
                else if (!self.broker!.connected)
                    callback(new Error("still no MQTT connection available"))
                else {
                    const data = Buffer.from(utils.streamChunkEncode(chunk))
                    self.broker!.publish(self.params.topicWrite, data, { qos: 2, retain: false }, (err) => {
                        if (err)
                            callback(new Error(`failed to publish to MQTT topic "${self.params.topicWrite}": ${err}`))
                        else
                            callback()
                    })
                }
            },
            read (size: number) {
                if (self.params.mode === "w")
                    throw new Error("read operation on write-only node")
                self.chunkQueue!.read().then((chunk) => {
                    this.push(chunk, "binary")
                }).catch((err: Error) => {
                    self.log("warning", `read on chunk queue operation failed: ${err}`)
                })
            }
        })
    }

    /*  close node  */
    async close () {
        /*  clear chunk queue reference  */
        this.chunkQueue = null

        /*  close MQTT broker  */
        if (this.broker !== null) {
            if (this.broker.connected)
                this.broker.end()
            this.broker = null
        }

        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }
    }
}
