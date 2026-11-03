/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream   from "node:stream"

/*  external dependencies  */
import { toCardinal as toCardinalDE } from "n2words/de"
import { toCardinal as toCardinalEN } from "n2words/en"
import { toCardinal as toCardinalFR } from "n2words/fr"
import { toCardinal as toCardinalIT } from "n2words/it"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  language-specific number conventions  */
type Language = "de" | "en" | "fr" | "it"
const languages: { [ lang in Language ]: {
    convert:   (value: string) => string,
    thousands: string,  /*  regex character class content of thousands separators  */
    decimal:   string   /*  regex character class content of decimal separators   */
} } = {
    de: { convert: toCardinalDE, thousands: ".",                decimal: "," },
    en: { convert: toCardinalEN, thousands: ",",                decimal: "." },
    fr: { convert: toCardinalFR, thousands: ". \\u00A0\\u202F", decimal: "," },
    it: { convert: toCardinalIT, thousands: ".",                decimal: "," }
}

/*  SpeechFlow node for spelling out numbers as words  */
export default class SpeechFlowNodeT2TNumbers extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2t-numbers"

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            lang: { type: "string", pos: 0, val: "en", match: /^(?:de|en|fr|it)$/ }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "text"
    }

    /*  open node  */
    async open () {
        /*  determine language conventions  */
        const { convert, thousands, decimal } = languages[this.params.lang as Language]

        /*  match a stand-alone number with optional thousands
            separators and optional decimal fraction  */
        const regex = new RegExp(
            "(?<![\\p{L}\\p{N}.,])" +
            `(\\d{1,3}(?:[${thousands}]\\d{3})+|\\d+)` +
            `(?:[${decimal}](\\d+))?` +
            "(?![\\p{L}\\p{N}]|[.,]\\d)", "gu")

        /*  spell out all numbers in a text  */
        const spellout = (text: string): string =>
            text.replace(regex, (match: string, int: string, frac: string | undefined, offset: number) => {
                /*  skip German ordinals (e.g. "am 3. Oktober"), as they would
                    require an inflected form which we cannot determine here  */
                if (this.params.lang === "de" && /^\.\s+\p{L}/u.test(text.substring(offset + match.length)))
                    return match
                const value = int.replace(/\D/g, "") + (frac !== undefined ? `.${frac}` : "")
                try {
                    return convert(value)
                }
                catch (_error) {
                    /*  out of range or unsupported: keep number as-is  */
                    return match
                }
            })

        /*  establish a transform stream and connect it to number spellout  */
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
                    const chunkNew = chunk.clone()
                    chunkNew.payload = spellout(chunk.payload)
                    this.push(chunkNew)
                    callback()
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}

