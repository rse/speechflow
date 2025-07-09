/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                          from "node:stream"

/*  external dependencies  */
import MQTT                            from "mqtt"
import UUID                            from "pure-uuid"

/*  internal dependencies  */
import SpeechFlowNode                  from "./speechflow-node"

/*  SpeechFlow node for MQTT networking  */
export default class SpeechFlowNodeMQTT extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "mqtt"

    /*  internal state  */
    private broker: MQTT.MqttClient | null = null
    private clientId: string = (new UUID(1)).format()

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            url:      { type: "string", pos: 0, val: "", match: /^(?:|(?:ws|mqtt):\/\/(.+?):(\d+)(?:\/.*)?)$/ },
            username: { type: "string", pos: 1, val: "", match: /^.+$/ },
            password: { type: "string", pos: 2, val: "", match: /^.+$/ },
            topic:    { type: "string", pos: 3, val: "", match: /^.+$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "none"
    }

    /*  open node  */
    async open () {
        /*  connect remotely to a Websocket port  */
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
        })
        this.broker.on("reconnect", () => {
            this.log("info", `connection re-established to MQTT ${this.params.url}`)
        })
        this.broker.on("disconnect", (packet: MQTT.IDisconnectPacket) => {
            this.log("info", `connection closed to MQTT ${this.params.url}`)
        })

        const broker = this.broker
        const topic  = this.params.topic
        const textEncoding = this.config.textEncoding
        this.stream = new Stream.Duplex({
            writableObjectMode: false,
            readableObjectMode: false,
            decodeStrings:      false,
            write (chunk: Buffer | string, encoding, callback) {
                if (Buffer.isBuffer(chunk))
                    chunk = chunk.toString(encoding ?? textEncoding)
                if (broker.connected) {
                    broker.publish(topic, chunk, { qos: 2, retain: false }, (err) => {
                        if (err)
                            callback(new Error(`failed to publish to MQTT topic "${topic}": ${err}`))
                        else
                            callback()
                    })
                }
                else
                    callback(new Error("still no MQTT connection available"))
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close Websocket server  */
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
