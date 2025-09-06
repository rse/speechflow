/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"

/*  external dependencies  */
import { TranslationServiceClient } from "@google-cloud/translate"
import * as arktype                 from "arktype"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  SpeechFlow node for Google Translate text-to-text translations  */
export default class SpeechFlowNodeT2TGoogle extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-google"

    /*  internal state  */
    private client: TranslationServiceClient | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            key: { type: "string",         val: process.env.SPEECHFLOW_GOOGLE_KEY ?? "" },
            src: { type: "string", pos: 0, val: "de", match: /^(?:de|en|fr|it)$/ },
            dst: { type: "string", pos: 1, val: "en", match: /^(?:de|en|fr|it)$/ }
        })

        /*  validate API key and project  */
        if (this.params.key === "")
            throw new Error("Google Cloud API credentials JSON key is required")

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
        /*  instantiate Google Translate client  */
        const data = util.run("Google Cloud API credentials key", () =>
            JSON.parse(this.params.key))
        const credentials = util.importObject("Google Cloud API credentials key",
            data,
            arktype.type({
                project_id:   "string",
                private_key:  "string",
                client_email: "string",
            })
        )
        this.client = new TranslationServiceClient({
            credentials: {
                private_key:  credentials.private_key,
                client_email: credentials.client_email
            },
            projectId: credentials.project_id
        })

        /*  provide text-to-text translation  */
        const translate = util.runner("Google Translate API", async (text: string) => {
            const [ response ] = await this.client!.translateText({
                parent:   `projects/${credentials.project_id}/locations/global`,
                contents: [ text ],
                mimeType: "text/plain",
                sourceLanguageCode: this.params.src,
                targetLanguageCode: this.params.dst
            })
            return response.translations?.[0]?.translatedText ?? text
        })

        /*  establish a duplex stream and connect it to Google Translate  */
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
                this.push(null)
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close stream  */
        if (this.stream !== null) {
            this.stream.destroy()
            this.stream = null
        }

        /*  shutdown Google Translate client  */
        if (this.client !== null) {
            this.client.close()
            this.client = null
        }
    }
}