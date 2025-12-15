/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import fs     from "node:fs"
import path   from "node:path"
import Stream from "node:stream"

/*  external dependencies  */
import { mkdirp }     from "mkdirp"
import * as HF        from "@huggingface/hub"
import SpeexResampler from "speex-resampler"
import { Duration }   from "luxon"

/*  @ts-expect-error no type available  */
import * as ORT       from "onnxruntime-node"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  ==== SUPERTONIC TTS IMPLEMENTATION ====  */

/*  type for voice style tensors  */
interface SupertonicStyle {
    ttl: ORT.Tensor
    dp:  ORT.Tensor
}

/*  type for TTS configuration  */
interface SupertonicConfig {
    ae: {
        sample_rate:           number
        base_chunk_size:       number
        chunk_compress_factor: number
    }
    ttl: {
        latent_dim:            number
        chunk_compress_factor: number
    }
}

/*  convert lengths to binary mask  */
function lengthToMask (lengths: number[], maxLen: number | null = null): number[][][] {
    /*  handle empty input  */
    if (lengths.length === 0)
        return []

    /*  determine maximum length  */
    maxLen = maxLen ?? Math.max(...lengths)

    /*  build mask array  */
    const mask: number[][][] = []
    for (let i = 0; i < lengths.length; i++) {
        const row: number[] = []
        for (let j = 0; j < maxLen; j++)
            row.push(j < lengths[i] ? 1.0 : 0.0)
        mask.push([ row ])
    }
    return mask
}

/*  get latent mask from wav lengths  */
function getLatentMask (wavLengths: number[], baseChunkSize: number, chunkCompressFactor: number): number[][][] {
    /*  calculate latent size and lengths  */
    const latentSize = baseChunkSize * chunkCompressFactor
    const latentLengths = wavLengths.map((len) =>
        Math.floor((len + latentSize - 1) / latentSize))

    /*  generate mask from latent lengths  */
    return lengthToMask(latentLengths)
}

/*  convert array to ONNX tensor  */
function arrayToTensor (array: number[] | number[][] | number[][][], dims: number[]): ORT.Tensor {
    /*  flatten array and create float32 tensor  */
    const flat = array.flat(Infinity) as number[]
    return new ORT.Tensor("float32", Float32Array.from(flat), dims)
}

/*  convert int array to ONNX tensor  */
function intArrayToTensor (array: number[][], dims: number[]): ORT.Tensor {
    /*  flatten array and create int64 tensor  */
    const flat = array.flat(Infinity) as number[]
    return new ORT.Tensor("int64", BigInt64Array.from(flat.map(BigInt)), dims)
}

/*  chunk text into manageable segments  */
function chunkText (text: string, maxLen = 300): string[] {
    /*  validate input type  */
    if (typeof text !== "string")
        throw new Error(`chunkText expects a string, got ${typeof text}`)

    /*  split by paragraph (two or more newlines)  */
    const paragraphs = text.trim().split(/\n\s*\n+/).filter((p) => p.trim())

    /*  process each paragraph into chunks  */
    const chunks: string[] = []
    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim()
        if (!paragraph)
            continue

        /*  split by sentence boundaries (period, question mark, exclamation mark followed by space)
            but exclude common abbreviations like Mr., Mrs., Dr., etc. and single capital letters like F.  */
        const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/)

        /*  accumulate sentences into chunks respecting max length  */
        let currentChunk = ""
        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= maxLen)
                currentChunk += (currentChunk ? " " : "") + sentence
            else {
                if (currentChunk)
                    chunks.push(currentChunk.trim())
                currentChunk = sentence
            }
        }

        /*  push remaining chunk  */
        if (currentChunk)
            chunks.push(currentChunk.trim())
    }
    return chunks
}

/*  unicode text processor class  */
class SupertonicTextProcessor {
    private indexer: Record<number, number>

    constructor (unicodeIndexerJsonPath: string) {
        /*  load and parse unicode indexer JSON  */
        try {
            this.indexer = JSON.parse(fs.readFileSync(unicodeIndexerJsonPath, "utf8"))
        }
        catch (err) {
            throw new Error(`failed to parse unicode indexer JSON "${unicodeIndexerJsonPath}"`, { cause: err })
        }
    }

    private preprocessText (text: string): string {
        /*  normalize text  */
        text = text.normalize("NFKD")

        /*  remove emojis (wide Unicode range)  */
        const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu
        text = text.replace(emojiPattern, "")

        /*  replace various dashes and symbols  */
        const replacements: Record<string, string> = {
            "–": "-",
            "‑": "-",
            "—": "-",
            "¯": " ",
            "_": " ",
            "\u201C": "\"",
            "\u201D": "\"",
            "\u2018": "'",
            "\u2019": "'",
            "´": "'",
            "`": "'",
            "[": " ",
            "]": " ",
            "|": " ",
            "/": " ",
            "#": " ",
            "→": " ",
            "←": " "
        }
        for (const [ k, v ] of Object.entries(replacements))
            text = text.replaceAll(k, v)

        /*  remove combining diacritics  */
        text = text.replace(/[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g, "")

        /*  remove special symbols  */
        text = text.replace(/[♥☆♡©\\]/g, "")

        /*  replace known expressions  */
        const exprReplacements: Record<string, string> = {
            "@":     " at ",
            "e.g.,": "for example, ",
            "i.e.,": "that is, "
        }
        for (const [ k, v ] of Object.entries(exprReplacements))
            text = text.replaceAll(k, v)

        /*  fix spacing around punctuation  */
        text = text.replace(/ ,/g,  ",")
        text = text.replace(/ \./g, ".")
        text = text.replace(/ !/g,  "!")
        text = text.replace(/ \?/g, "?")
        text = text.replace(/ ;/g,  ";")
        text = text.replace(/ :/g,  ":")
        text = text.replace(/ '/g,  "'")

        /*  remove duplicate quotes  */
        text = text.replace(/""+/g, "\"")
        text = text.replace(/''+/g, "'")
        text = text.replace(/``+/g, "`")

        /*  remove extra spaces  */
        text = text.replace(/\s+/g, " ").trim()

        /*  if text doesn't end with punctuation, add a period  */
        if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text))
            text += "."
        return text
    }

    private textToUnicodeValues (text: string): number[] {
        /*  convert text characters to unicode code points  */
        return Array.from(text).map((char) => char.charCodeAt(0))
    }

    call (textList: string[]): { textIds: number[][], textMask: number[][][] } {
        /*  handle empty input  */
        if (textList.length === 0)
            return { textIds: [], textMask: [] }

        /*  preprocess all texts  */
        const processedTexts = textList.map((t) => this.preprocessText(t))
        const textIdsLengths = processedTexts.map((t) => t.length)
        const maxLen = Math.max(...textIdsLengths)

        /*  convert texts to indexed token arrays  */
        const textIds: number[][] = []
        for (let i = 0; i < processedTexts.length; i++) {
            const row = Array.from<number>({ length: maxLen }).fill(0)
            const unicodeVals = this.textToUnicodeValues(processedTexts[i])
            for (let j = 0; j < unicodeVals.length; j++)
                row[j] = this.indexer[unicodeVals[j]] ?? 0
            textIds.push(row)
        }

        /*  generate text mask from lengths  */
        const textMask = lengthToMask(textIdsLengths)
        return { textIds, textMask }
    }
}

/*  Supertonic TTS engine class  */
class SupertonicTTS {
    public  sampleRate:          number

    private cfgs:                SupertonicConfig
    private textProcessor:       SupertonicTextProcessor
    private dpOrt:               ORT.InferenceSession
    private textEncOrt:          ORT.InferenceSession
    private vectorEstOrt:        ORT.InferenceSession
    private vocoderOrt:          ORT.InferenceSession
    private baseChunkSize:       number
    private chunkCompressFactor: number
    private latentDim:           number

    constructor (
        cfgs:          SupertonicConfig,
        textProcessor: SupertonicTextProcessor,
        dpOrt:         ORT.InferenceSession,
        textEncOrt:    ORT.InferenceSession,
        vectorEstOrt:  ORT.InferenceSession,
        vocoderOrt:    ORT.InferenceSession
    ) {
        /*  store configuration and dependencies  */
        this.cfgs                = cfgs
        this.textProcessor       = textProcessor
        this.dpOrt               = dpOrt
        this.textEncOrt          = textEncOrt
        this.vectorEstOrt        = vectorEstOrt
        this.vocoderOrt          = vocoderOrt

        /*  extract configuration values  */
        this.sampleRate          = cfgs.ae.sample_rate
        this.baseChunkSize       = cfgs.ae.base_chunk_size
        this.chunkCompressFactor = cfgs.ttl.chunk_compress_factor
        this.latentDim           = cfgs.ttl.latent_dim
    }

    private sampleNoisyLatent (duration: number[]): { noisyLatent: number[][][], latentMask: number[][][] } {
        /*  calculate dimensions for latent space  */
        const wavLenMax  = Math.max(...duration) * this.sampleRate
        const wavLengths = duration.map((d) => Math.floor(d * this.sampleRate))
        const chunkSize  = this.baseChunkSize * this.chunkCompressFactor
        const latentLen  = Math.floor((wavLenMax + chunkSize - 1) / chunkSize)
        const latentDimExpanded = this.latentDim * this.chunkCompressFactor

        /*  generate random noise (pre-allocate arrays for performance)  */
        const noisyLatent: number[][][] = Array.from({ length: duration.length })
        for (let b = 0; b < duration.length; b++) {
            const batch: number[][] = Array.from({ length: latentDimExpanded })
            for (let d = 0; d < latentDimExpanded; d++) {
                const row: number[] = Array.from({ length: latentLen })
                for (let t = 0; t < latentLen; t++) {

                    /*  Box-Muller transform for normal distribution  */
                    const eps = 1e-10
                    const u1 = Math.max(eps, Math.random())
                    const u2 = Math.random()
                    row[t] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
                }
                batch[d] = row
            }
            noisyLatent[b] = batch
        }

        /*  apply mask  */
        const latentMask = getLatentMask(wavLengths, this.baseChunkSize, this.chunkCompressFactor)
        for (let b = 0; b < noisyLatent.length; b++) {
            for (let d = 0; d < noisyLatent[b].length; d++) {
                for (let t = 0; t < noisyLatent[b][d].length; t++)
                    noisyLatent[b][d][t] *= latentMask[b][0][t]
            }
        }
        return { noisyLatent, latentMask }
    }

    private async infer (textList: string[], style: SupertonicStyle, totalStep: number, speed: number): Promise<{ wav: number[], duration: number[] }> {
        /*  validate batch size matches style vectors  */
        if (textList.length !== style.ttl.dims[0])
            throw new Error("Number of texts must match number of style vectors")

        /*  process text into token IDs and masks  */
        const batchSize = textList.length
        const { textIds, textMask } = this.textProcessor.call(textList)
        const textIdsShape = [ batchSize, textIds[0].length ]
        const textMaskShape = [ batchSize, 1, textMask[0][0].length ]
        const textMaskTensor = arrayToTensor(textMask, textMaskShape)

        /*  run duration predictor model  */
        const dpResult = await this.dpOrt.run({
            text_ids:  intArrayToTensor(textIds, textIdsShape),
            style_dp:  style.dp,
            text_mask: textMaskTensor
        })
        const predictedDurations = Array.from(dpResult.duration.data as Float32Array)

        /*  apply speed factor to duration  */
        for (let i = 0; i < predictedDurations.length; i++)
            predictedDurations[i] /= speed

        /*  run text encoder model  */
        const textEncResult = await this.textEncOrt.run({
            text_ids:  intArrayToTensor(textIds, textIdsShape),
            style_ttl: style.ttl,
            text_mask: textMaskTensor
        })
        const textEmbTensor = textEncResult.text_emb

        /*  sample initial noisy latent vectors  */
        const { noisyLatent, latentMask } = this.sampleNoisyLatent(predictedDurations)
        const latentShape = [ batchSize, noisyLatent[0].length, noisyLatent[0][0].length ]
        const latentMaskShape = [ batchSize, 1, latentMask[0][0].length ]
        const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape)

        /*  prepare step tensors  */
        const totalStepArray = Array.from<number>({ length: batchSize }).fill(totalStep)
        const scalarShape = [ batchSize ]
        const totalStepTensor = arrayToTensor(totalStepArray, scalarShape)

        /*  iteratively denoise latent vectors  */
        for (let step = 0; step < totalStep; step++) {
            const currentStepArray = Array.from<number>({ length: batchSize }).fill(step)

            /*  run vector estimator model  */
            const vectorEstResult = await this.vectorEstOrt.run({
                noisy_latent: arrayToTensor(noisyLatent, latentShape),
                text_emb:     textEmbTensor,
                style_ttl:    style.ttl,
                text_mask:    textMaskTensor,
                latent_mask:  latentMaskTensor,
                total_step:   totalStepTensor,
                current_step: arrayToTensor(currentStepArray, scalarShape)
            })
            const denoisedLatent = Array.from(vectorEstResult.denoised_latent.data as Float32Array)

            /*  update latent with the denoised output  */
            let idx = 0
            for (let b = 0; b < noisyLatent.length; b++)
                for (let d = 0; d < noisyLatent[b].length; d++)
                    for (let t = 0; t < noisyLatent[b][d].length; t++)
                        noisyLatent[b][d][t] = denoisedLatent[idx++]
        }

        /*  run vocoder to generate audio waveform  */
        const vocoderResult = await this.vocoderOrt.run({
            latent: arrayToTensor(noisyLatent, latentShape)
        })
        const wav = Array.from(vocoderResult.wav_tts.data as Float32Array)
        return { wav, duration: predictedDurations }
    }

    async synthesize (text: string, style: SupertonicStyle, totalStep: number, speed: number, silenceDuration = 0.3): Promise<{ wav: number[], duration: number }> {
        /*  validate single speaker mode  */
        if (style.ttl.dims[0] !== 1)
            throw new Error("Single speaker text to speech only supports single style")

        /*  chunk text into segments  */
        const textList = chunkText(text)
        if (textList.length === 0)
            return { wav: [], duration: 0 }

        /*  synthesize each chunk and concatenate with silence  */
        const wavParts: number[][] = []
        let totalDuration = 0
        for (const chunk of textList) {
            const { wav, duration } = await this.infer([ chunk ], style, totalStep, speed)

            /*  insert silence between chunks  */
            if (wavParts.length > 0) {
                const silenceLen = Math.floor(silenceDuration * this.sampleRate)
                wavParts.push(Array.from<number>({ length: silenceLen }).fill(0))
                totalDuration += silenceDuration
            }
            wavParts.push(wav)
            totalDuration += duration[0]
        }
        return { wav: wavParts.flat(), duration: totalDuration }
    }

    async release (): Promise<void> {
        /*  release all ONNX inference sessions  */
        await Promise.all([
            this.dpOrt.release(),
            this.textEncOrt.release(),
            this.vectorEstOrt.release(),
            this.vocoderOrt.release()
        ])
    }
}

/*  type for voice style JSON file  */
interface VoiceStyleJSON {
    style_ttl: { dims: number[], data: number[][][] }
    style_dp:  { dims: number[], data: number[][][] }
}

/*  load voice style from JSON file  */
async function loadVoiceStyle (voiceStylePath: string): Promise<SupertonicStyle> {
    /*  read and parse voice style JSON  */
    let voiceStyle: VoiceStyleJSON
    try {
        voiceStyle = JSON.parse(await fs.promises.readFile(voiceStylePath, "utf8")) as VoiceStyleJSON
    }
    catch (err) {
        throw new Error(`failed to parse voice style JSON "${voiceStylePath}"`, { cause: err })
    }

    /*  extract dimensions and data  */
    const ttlDims  = voiceStyle.style_ttl.dims
    const dpDims   = voiceStyle.style_dp.dims
    const ttlData  = voiceStyle.style_ttl.data.flat(Infinity) as number[]
    const dpData   = voiceStyle.style_dp.data.flat(Infinity) as number[]

    /*  create ONNX tensors for style vectors  */
    const ttlStyle = new ORT.Tensor("float32", Float32Array.from(ttlData), ttlDims)
    const dpStyle  = new ORT.Tensor("float32", Float32Array.from(dpData), dpDims)
    return { ttl: ttlStyle, dp: dpStyle }
}

/*  load TTS engine from ONNX models  */
async function loadSupertonic (assetsDir: string): Promise<SupertonicTTS> {
    /*  load configuration  */
    const cfgPath = path.join(assetsDir, "onnx", "tts.json")
    let cfgs: SupertonicConfig
    try {
        cfgs = JSON.parse(await fs.promises.readFile(cfgPath, "utf8"))
    }
    catch (err) {
        throw new Error(`failed to parse TTS config JSON "${cfgPath}"`, { cause: err })
    }

    /*  load text processor  */
    const unicodeIndexerPath = path.join(assetsDir, "onnx", "unicode_indexer.json")
    const textProcessor = new SupertonicTextProcessor(unicodeIndexerPath)

    /*  load ONNX models  */
    const opts: ORT.InferenceSession.SessionOptions = {}
    const [ dpOrt, textEncOrt, vectorEstOrt, vocoderOrt ] = await Promise.all([
        ORT.InferenceSession.create(path.join(assetsDir, "onnx", "duration_predictor.onnx"), opts),
        ORT.InferenceSession.create(path.join(assetsDir, "onnx", "text_encoder.onnx"), opts),
        ORT.InferenceSession.create(path.join(assetsDir, "onnx", "vector_estimator.onnx"), opts),
        ORT.InferenceSession.create(path.join(assetsDir, "onnx", "vocoder.onnx"), opts)
    ])
    return new SupertonicTTS(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt)
}

/*  ==== SPEECHFLOW NODE IMPLEMENTATION ====  */

/*  SpeechFlow node for Supertonic text-to-speech conversion  */
export default class SpeechFlowNodeT2ASupertonic extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "t2a-supertonic"

    /*  internal state  */
    private supertonic: SupertonicTTS   | null = null
    private style:      SupertonicStyle | null = null
    private resampler:  SpeexResampler  | null = null
    private closing                            = false

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            voice: { type: "string", val: "M1", pos: 0, match: /^(?:M1|M2|F1|F2)$/ },
            speed: { type: "number", val: 1.40, pos: 1, match: (n: number) => n >= 0.5 && n <= 2.0 },
            steps: { type: "number", val: 20,   pos: 2, match: (n: number) => n >= 1   && n <= 20 }
        })

        /*  declare node input/output format  */
        this.input  = "text"
        this.output = "audio"
    }

    /*  one-time status of node  */
    async status () {
        return {}
    }

    /*  download HuggingFace assets  */
    private async downloadAssets () {
        /*  define HuggingFace repository and required files  */
        const assetRepo = "Supertone/supertonic"
        const assetFiles = [
            "voice_styles/F1.json",
            "voice_styles/F2.json",
            "voice_styles/M1.json",
            "voice_styles/M2.json",
            "onnx/tts.json",
            "onnx/duration_predictor.onnx",
            "onnx/text_encoder.onnx",
            "onnx/unicode_indexer.json",
            "onnx/vector_estimator.onnx",
            "onnx/vocoder.onnx"
        ]

        /*  create asset directories  */
        const assetDir = path.join(this.config.cacheDir, "supertonic")
        await mkdirp(path.join(assetDir, "voice_styles"), { mode: 0o750 })
        await mkdirp(path.join(assetDir, "onnx"), { mode: 0o750 })

        /*  download missing asset files  */
        for (const assetFile of assetFiles) {
            const url = `${assetRepo}/${assetFile}`
            const file = path.join(assetDir, assetFile)
            const stat = await fs.promises.stat(file).catch((_err) => null)
            if (stat === null || !stat.isFile()) {
                this.log("info", `downloading from HuggingFace "${url}"`)
                const response = await HF.downloadFile({ repo: assetRepo, path: assetFile })
                if (!response)
                    throw new Error(`failed to download from HuggingFace "${url}"`)
                const buffer = Buffer.from(await response.arrayBuffer())
                await fs.promises.writeFile(file, buffer)
            }
        }
        return assetDir
    }

    /*  open node  */
    async open () {
        this.closing = false

        /*  download assets  */
        const assetsDir = await this.downloadAssets()

        /*  download ONNX models  */
        this.log("info", `loading ONNX models (asset dir: "${assetsDir}")`)
        this.supertonic = await loadSupertonic(assetsDir)
        this.log("info", `loaded ONNX models (sample rate: ${this.supertonic.sampleRate}Hz)`)

        /*  load voice style  */
        const voiceStylePath = path.join(assetsDir, "voice_styles", `${this.params.voice}.json`)
        if (!fs.existsSync(voiceStylePath))
            throw new Error(`voice style not found: ${voiceStylePath}`)
        this.log("info", `loading voice style "${this.params.voice}"`)
        this.style = await loadVoiceStyle(voiceStylePath)
        this.log("info", `loaded voice style "${this.params.voice}"`)

        /*  establish resampler from Supertonic's output sample rate to our standard audio sample rate (48kHz)  */
        this.resampler = new SpeexResampler(1, this.supertonic.sampleRate, this.config.audioSampleRate, 7)

        /*  perform text-to-speech operation with Supertonic  */
        const text2speech = async (text: string) => {
            /*  synthesize speech from text  */
            this.log("info", `Supertonic: input: "${text}"`)
            const { wav, duration } = await this.supertonic!.synthesize(
                text,
                this.style!,
                this.params.steps,
                this.params.speed
            )
            this.log("info", `Supertonic: synthesized ${duration.toFixed(2)}s of audio`)

            /*  convert audio samples from PCM/F32 to PCM/I16  */
            const buffer1 = Buffer.alloc(wav.length * 2)
            for (let i = 0; i < wav.length; i++) {
                const sample = Math.max(-1, Math.min(1, wav[i]))
                buffer1.writeInt16LE(sample * 0x7FFF, i * 2)
            }

            /*  resample audio samples from Supertonic sample rate to 48kHz  */
            return this.resampler!.processChunk(buffer1)
        }

        /*  create transform stream and connect it to the Supertonic TTS  */
        const self = this
        this.stream = new Stream.Transform({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            async transform (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.closing)
                    callback(new Error("stream already destroyed"))
                else if (Buffer.isBuffer(chunk.payload))
                    callback(new Error("invalid chunk payload type"))
                else if (chunk.payload === "")
                    callback()
                else {
                    let processTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                        processTimeout = null
                        callback(new Error("Supertonic TTS timeout"))
                    }, 120 * 1000)
                    const clearProcessTimeout = () => {
                        if (processTimeout !== null) {
                            clearTimeout(processTimeout)
                            processTimeout = null
                        }
                    }
                    try {
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        const buffer = await text2speech(chunk.payload as string)
                        if (self.closing) {
                            clearProcessTimeout()
                            callback(new Error("stream destroyed during processing"))
                            return
                        }
                        self.log("info", `Supertonic: received audio (buffer length: ${buffer.byteLength})`)

                        /*  calculate actual audio duration from PCM buffer size  */
                        const durationMs = util.audioBufferDuration(buffer,
                            self.config.audioSampleRate, self.config.audioBitDepth) * 1000

                        /*  create new chunk with recalculated timestamps  */
                        const chunkNew = chunk.clone()
                        chunkNew.type         = "audio"
                        chunkNew.payload      = buffer
                        chunkNew.timestampEnd = Duration.fromMillis(chunkNew.timestampStart.toMillis() + durationMs)

                        /*  push chunk and complete transform  */
                        clearProcessTimeout()
                        this.push(chunkNew)
                        callback()
                    }
                    catch (error) {
                        /*  handle processing errors  */
                        clearProcessTimeout()
                        callback(util.ensureError(error, "Supertonic processing failed"))
                    }
                }
            },
            final (callback) {
                callback()
            }
        })
    }

    /*  close node  */
    async close () {
        /*  indicate closing  */
        this.closing = true

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }

        /*  destroy voice style  */
        if (this.style !== null)
            this.style = null

        /*  destroy resampler  */
        if (this.resampler !== null)
            this.resampler = null

        /*  destroy Supertonic TTS  */
        if (this.supertonic !== null) {
            await this.supertonic.release()
            this.supertonic = null
        }
    }
}
