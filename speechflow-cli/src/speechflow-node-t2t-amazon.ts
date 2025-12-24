/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                                    from "node:stream"

/*  external dependencies  */
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Amazon Translate text-to-text translations  */
export default class SpeechFlowNodeT2TAmazon extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-amazon"

    /*  internal state  */
    private client: TranslateClient | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key:      { type: "string",         val: process.env.SPEECHFLOW_AMAZON_KEY },
            secKey:   { type: "string",         val: process.env.SPEECHFLOW_AMAZON_KEY_SEC },
            region:   { type: "string",         val: "eu-central-1" },
            src:      { type: "string", pos: 0, val: "de", match: /^(?:de|en|fr|it)$/ },
            dst:      { type: "string", pos: 1, val: "en", match: /^(?:de|en|fr|it)$/ }
        })

        /*  sanity check parameters  */
        if (!this.params.key)
            throw new Error("AWS Access Key not configured")
        if (!this.params.secKey)
            throw new Error("AWS Secret Access Key not configured")

        /*  sanity check situation  */
        if (this.params.src === this.params.dst)
            throw new Error("source and destination languages cannot be the same")

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  one-time status of node  */
    async status () {
        return {}
    }

    /*  open node  */
    async open () {
        /*  connect to Amazon Translate API  */
        this.client = new TranslateClient({
            region: this.params.region,
            credentials: {
                accessKeyId:     this.params.key,
                secretAccessKey: this.params.secKey
            }
        })

        /*  provide text-to-text translation  */
        const maxRetries = 10
        const translate = async (text: string): Promise<string> => {
            let attempt = 0
            let lastError: unknown
            while (attempt < maxRetries) {
                try {
                    const cmd = new TranslateTextCommand({
                        SourceLanguageCode: this.params.src,
                        TargetLanguageCode: this.params.dst,
                        Text: text,
                        Settings: {
                            Formality: "INFORMAL",
                            Brevity:   "ON"
                        }
                    })
                    const out = await this.client!.send(cmd)
                    return (out.TranslatedText ?? "").trim()
                }
                catch (e: any) {
                    lastError = e
                    attempt += 1

                    /*  simple backoff for transient errors  */
                    const retriable =
                        e?.name === "ThrottlingException"
                        || e?.name === "ServiceUnavailableException"
                        || e?.$retryable === true
                    if (!retriable || attempt >= maxRetries)
                        break
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
                    await util.sleep(delayMs)
                }
            }
            throw util.ensureError(lastError)
        }

        /*  establish a transform stream and connect it to AWS Translate  */
        this.stream = new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "") {
                    this.push(chunk)
                    callback()
                }
                else {
                    translate(chunk.payload).then((payload) => {
                        const chunkNew = chunk.clone()
                        chunkNew.payload = payload
                        this.push(chunkNew)
                        callback()
                    }).catch((error: unknown) => {
                        callback(util.ensureError(error))
                    })
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close Amazon Translate connection  */
        if (this.client !== null) {
            this.client.destroy()
            this.client = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

