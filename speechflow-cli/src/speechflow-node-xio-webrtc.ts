/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream from "node:stream"
import http   from "node:http"
import crypto from "node:crypto"

/*  external dependencies  */
import { DateTime }    from "luxon"
import * as arktype    from "arktype"
import { OpusEncoder } from "@discordjs/opus"
import {
    RTCPeerConnection, MediaStreamTrack,
    RtpPacket, RtpHeader,
    useAbsSendTime, useSdesMid
} from "werift"

/*  internal dependencies  */
import SpeechFlowNode, { SpeechFlowChunk } from "./speechflow-node"
import * as util                           from "./speechflow-util"

/*  WebRTC peer connection state  */
interface WebRTCConnection {
    pc:           RTCPeerConnection
    track:        MediaStreamTrack | null
    resourceId:   string
    subscription: { unSubscribe: () => void } | null
}

/*  SpeechFlow node for WebRTC networking (WHIP/WHEP)  */
export default class SpeechFlowNodeXIOWebRTC extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-webrtc"

    /*  internal state  */
    private peerConnections                                       = new Map<string, WebRTCConnection>()
    private httpServer:  http.Server                       | null = null
    private chunkQueue:  util.SingleQueue<SpeechFlowChunk> | null = null
    private opusEncoder: OpusEncoder                       | null = null
    private opusDecoder: OpusEncoder                       | null = null
    private pcmBuffer                                             = Buffer.alloc(0)
    private rtpSequence                                           = 0
    private rtpTimestamp                                          = 0
    private rtpSSRC                                               = 0
    private maxConnections                                        = 10

    /*  Opus codec configuration: 48kHz, mono, 16-bit  */
    private readonly OPUS_SAMPLE_RATE = 48000
    private readonly OPUS_CHANNELS    = 1
    private readonly OPUS_BIT_DEPTH   = 16
    private readonly OPUS_FRAME_SIZE  = 960              /*  20ms at 48kHz = 960 samples  */
    private readonly OPUS_FRAME_BYTES = 960 * 2          /*  16-bit = 2 bytes per sample  */

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            listen:     { type: "string", pos: 0, val: "8085",    match: /^(?:\d+|.+?:\d+)$/ },
            path:       { type: "string", pos: 1, val: "/webrtc", match: /^\/.+$/ },
            mode:       { type: "string", pos: 2, val: "r",       match: /^(?:r|w)$/ },
            iceServers: { type: "string", pos: 3, val: "",        match: /^.*$/ }
        })

        /*  declare node input/output format  */
        if (this.params.mode === "r") {
            this.input  = "none"
            this.output = "audio"
        }
        else if (this.params.mode === "w") {
            this.input  = "audio"
            this.output = "none"
        }
    }

    /*  parse address:port string  */
    private parseAddress (addr: string, defaultPort: number): { host: string, port: number } {
        if (addr.match(/^\d+$/))
            return { host: "0.0.0.0", port: Number.parseInt(addr, 10) }
        const m = addr.match(/^(.+?):(\d+)$/)
        if (m === null)
            return { host: addr, port: defaultPort }
        return { host: m[1], port: Number.parseInt(m[2], 10) }
    }

    /*  read HTTP request body  */
    private readRequestBody (req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            const maxBodySize = 1024 * 1024  /*  1 MB limit for SDP  */
            let totalSize = 0
            const onData = (chunk: Buffer) => {
                totalSize += chunk.length
                if (totalSize > maxBodySize) {
                    req.removeListener("data",  onData)
                    req.removeListener("end",   onEnd)
                    req.removeListener("error", onError)
                    req.destroy()
                    reject(new Error("request body too large"))
                    return
                }
                chunks.push(chunk)
            }
            const onEnd = () =>
                resolve(Buffer.concat(chunks).toString("utf8"))
            const onError = (err: Error) =>
                reject(err)
            req.on("data", onData)
            req.on("end", onEnd)
            req.on("error", onError)
        })
    }

    /*  decode Opus packet to PCM and enqueue as SpeechFlowChunk  */
    private decodeOpusToChunk (opusPacket: Buffer) {
        if (this.opusDecoder === null || this.chunkQueue === null)
            return
        if (this.params.mode === "w")
            return
        try {
            /*  decode Opus to PCM (16-bit signed, little-endian, 48kHz)  */
            const pcmBuffer = this.opusDecoder.decode(opusPacket)

            /*  create chunk with timing information (use Opus codec rates, not config)  */
            const now = DateTime.now()
            const start = now.diff(this.timeZero)
            const duration = util.audioBufferDuration(pcmBuffer,
                this.OPUS_SAMPLE_RATE, this.OPUS_BIT_DEPTH, this.OPUS_CHANNELS)
            const end = start.plus(duration * 1000)
            const chunk = new SpeechFlowChunk(start, end, "final", "audio", pcmBuffer)
            this.chunkQueue.write(chunk)
        }
        catch (err: unknown) {
            this.log("warning", `Opus decode error: ${util.ensureError(err).message}`)
        }
    }

    /*  buffer PCM and encode to Opus frames, send to all viewers  */
    private bufferAndEncode (chunk: SpeechFlowChunk) {
        if (this.opusEncoder === null)
            return
        const pcm = chunk.payload as Buffer
        this.pcmBuffer = Buffer.concat([ this.pcmBuffer, pcm ])

        /*  prevent unbounded buffer growth  */
        const maxBufferSize = this.OPUS_FRAME_BYTES * 10
        if (this.pcmBuffer.length > maxBufferSize) {
            this.log("warning", `PCM buffer overflow (${this.pcmBuffer.length} bytes), discarding excess`)
            this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - maxBufferSize)
        }

        /*  process full Opus frames from buffer  */
        while (this.pcmBuffer.length >= this.OPUS_FRAME_BYTES) {
            const frame = this.pcmBuffer.subarray(0, this.OPUS_FRAME_BYTES)
            this.pcmBuffer = this.pcmBuffer.subarray(this.OPUS_FRAME_BYTES)
            try {
                /*  encode PCM to Opus  */
                const opusPacket = this.opusEncoder.encode(frame)
                this.sendOpusToAllViewers(opusPacket)
            }
            catch (err: unknown) {
                this.log("warning", `Opus encode error: ${util.ensureError(err).message}`)
            }
        }
    }

    /*  send Opus packet to all connected WHEP viewers  */
    private sendOpusToAllViewers (opusPacket: Buffer) {
        /*  build RTP header  */
        const rtpHeader = new RtpHeader({
            version:        2,
            padding:        false,
            paddingSize:    0,
            extension:      false,
            marker:         true,
            payloadType:    111, /*  Opus payload type  */
            sequenceNumber: this.rtpSequence++ & 0xFFFF,
            timestamp:      this.rtpTimestamp,
            ssrc:           this.rtpSSRC,
            csrc:           [],
            extensions:     []
        })

        /*  build RTP packet  */
        const rtpPacket = new RtpPacket(rtpHeader, opusPacket)

        /*  advance timestamp by frame duration  */
        this.rtpTimestamp = (this.rtpTimestamp + this.OPUS_FRAME_SIZE) >>> 0

        /*  send to all connected viewers (snapshot to avoid concurrent modification)  */
        const connections = Array.from(this.peerConnections.values())
        for (const conn of connections) {
            if (conn.track !== null) {
                try {
                    conn.track.writeRtp(rtpPacket)
                }
                catch (err: unknown) {
                    this.log("warning", `failed to send RTP to WebRTC peer: ${util.ensureError(err).message}`)
                }
            }
        }
    }

    /*  parse ICE servers configuration  */
    private parseIceServers (): { urls: string }[] {
        if (this.params.iceServers === "")
            return []
        let servers: { urls: string }[] = []
        try {
            servers = util.importObject("WebRTC ICE servers",
                this.params.iceServers,
                arktype.type({ urls: "string" }).array())
        }
        catch (err: unknown) {
            this.log("warning", `invalid iceServers JSON: ${util.ensureError(err).message}`)
            servers = []
        }
        return servers
    }

    /*  create a new RTCPeerConnection with standard configuration  */
    private createPeerConnection (resourceId: string): { pc: RTCPeerConnection, subscription: { unSubscribe: () => void } } {
        const pc = new RTCPeerConnection({
            iceServers: this.parseIceServers(),
            headerExtensions: {
                audio: [ useSdesMid(), useAbsSendTime() ]
            }
        })
        const subscription = pc.connectionStateChange.subscribe((state: string) => {
            this.log("info", `WebRTC connection ${resourceId}: ${state}`)
            if (state === "failed" || state === "closed" || state === "disconnected")
                setImmediate(() => {
                    if (this.peerConnections.has(resourceId))
                        this.cleanupConnection(resourceId)
                })
        })
        return { pc, subscription }
    }

    /*  safely close a peer connection  */
    private closePeerConnection (pc: RTCPeerConnection) {
        util.shield(() => { pc.close() })
    }

    /*  perform SDP negotiation and establish connection  */
    private async performSDPNegotiation (
        res:      http.ServerResponse,
        offer:    string,
        protocol: "WHIP" | "WHEP",
        setupFn:  (pc: RTCPeerConnection, resourceId: string) => MediaStreamTrack | null
    ) {
        /*  enforce connection limit  */
        if (this.peerConnections.size >= this.maxConnections) {
            res.writeHead(503, { "Content-Type": "text/plain" })
            res.end("Service Unavailable: Maximum connections reached")
            return
        }

        /*  create peer connection  */
        const resourceId = crypto.randomUUID()
        const { pc, subscription } = this.createPeerConnection(resourceId)

        /*  protocol-specific setup  */
        const track = setupFn(pc, resourceId)

        /*  complete SDP offer/answer exchange and establish connection  */
        try {
            /*  set remote description (offer from client)  */
            await pc.setRemoteDescription({ type: "offer", sdp: offer })

            /*  create and set local description (answer)  */
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)

            /*  store connection  */
            this.peerConnections.set(resourceId, { pc, track, resourceId, subscription })

            /*  return SDP answer  */
            if (pc.localDescription === null || pc.localDescription === undefined)
                throw new Error("local description is missing")
            res.writeHead(201, {
                "Content-Type": "application/sdp",
                "Location":     `${this.params.path}/${resourceId}`
            })
            res.end(pc.localDescription.sdp)
            this.log("info", `${protocol} connection established: ${resourceId}`)
        }
        catch (err: unknown) {
            util.shield(() => { subscription.unSubscribe() })
            this.closePeerConnection(pc)
            this.log("error", `${protocol} negotiation failed: ${util.ensureError(err).message}`)
            res.writeHead(500, { "Content-Type": "text/plain" })
            res.end("Internal Server Error")
        }
    }

    /*  handle WHIP POST (receiving audio from publisher)  */
    private async handleWHIP (res: http.ServerResponse, offer: string) {
        await this.performSDPNegotiation(res, offer, "WHIP", (pc, _resourceId) => {
            /*  handle incoming audio track  */
            pc.ontrack = (event: { track: MediaStreamTrack }) => {
                const track = event.track
                if (track.kind === "audio") {
                    this.log("info", "WebRTC audio track received from publisher")

                    /*  subscribe to incoming RTP packets  */
                    track.onReceiveRtp.subscribe((rtpPacket: RtpPacket) => {
                        this.decodeOpusToChunk(rtpPacket.payload)
                    })
                }
            }
            return null
        })
    }

    /*  handle WHEP POST (sending audio to viewer)  */
    private async handleWHEP (res: http.ServerResponse, offer: string) {
        await this.performSDPNegotiation(res, offer, "WHEP", (pc, _resourceId) => {
            /*  create outbound audio track  */
            const outboundTrack = new MediaStreamTrack({ kind: "audio" })
            pc.addTrack(outboundTrack)
            return outboundTrack
        })
    }

    /*  handle DELETE (connection teardown)  */
    private handleDELETE (res: http.ServerResponse, resourceId: string) {
        if (this.peerConnections.has(resourceId)) {
            this.cleanupConnection(resourceId)
            res.writeHead(200)
            res.end()
            this.log("info", `WebRTC connection terminated: ${resourceId}`)
        }
        else {
            res.writeHead(404, { "Content-Type": "text/plain" })
            res.end("Not Found")
        }
    }

    /*  cleanup a peer connection  */
    private cleanupConnection (resourceId: string) {
        const conn = this.peerConnections.get(resourceId)
        if (conn === undefined)
            return
        this.peerConnections.delete(resourceId)
        if (conn.subscription !== null)
            util.shield(() => { conn.subscription?.unSubscribe() })
        if (conn.track !== null)
            util.shield(() => { conn.track?.stop() })
        this.closePeerConnection(conn.pc)
    }

    /*  open node  */
    async open () {
        /*  setup Opus codec  */
        this.opusEncoder = new OpusEncoder(this.OPUS_SAMPLE_RATE, this.OPUS_CHANNELS)
        this.opusDecoder = new OpusEncoder(this.OPUS_SAMPLE_RATE, this.OPUS_CHANNELS)

        /*  initialize RTP state  */
        this.rtpSequence  = Math.floor(Math.random() * 0x10000)
        this.rtpTimestamp = Math.floor(Math.random() * 0x100000000) >>> 0
        this.rtpSSRC      = Math.floor(Math.random() * 0x100000000) >>> 0

        /*  setup chunk queue for incoming audio  */
        this.chunkQueue = new util.SingleQueue<SpeechFlowChunk>()

        /*  parse listen address  */
        const listen = this.parseAddress(this.params.listen, 8085)

        /*  setup HTTP server for WHIP/WHEP signaling  */
        const self = this
        this.httpServer = http.createServer(async (req, res) => {
            /*  determine URL  */
            if (req.url === undefined) {
                res.writeHead(400, { "Content-Type": "text/plain" })
                res.end("Bad Request")
                return
            }
            const host = req.headers.host?.replace(/[^a-zA-Z0-9:.\-_]/g, "") ?? "localhost"
            const url = new URL(req.url, `http://${host}`)
            const pathMatch = url.pathname === self.params.path
            const resourceMatch = url.pathname.startsWith(self.params.path + "/")

            /*  CORS headers for browser clients  */
            res.setHeader("Access-Control-Allow-Origin",   "*")
            res.setHeader("Access-Control-Allow-Methods",  "POST, DELETE, OPTIONS")
            res.setHeader("Access-Control-Allow-Headers",  "Content-Type")
            res.setHeader("Access-Control-Expose-Headers", "Location")

            /*  handle CORS preflight  */
            if (req.method === "OPTIONS") {
                res.writeHead(204)
                res.end()
                return
            }

            /*  handle requests...  */
            if (req.method === "POST" && pathMatch) {
                /*  handle WHIP/WHEP POST  */
                const body = await self.readRequestBody(req)

                /*  sanity check content type  */
                const contentType = req.headers["content-type"]
                if (contentType !== "application/sdp") {
                    res.writeHead(415, { "Content-Type": "text/plain" })
                    res.end("Unsupported Media Type")
                    return
                }

                /*  determine if WHIP (receiving) or WHEP (sending) based on SDP content  */
                const hasSendonly  = /\ba=sendonly\b/m.test(body)
                const hasSendrecv  = /\ba=sendrecv\b/m.test(body)
                const hasRecvonly  = /\ba=recvonly\b/m.test(body)
                const isPublisher  = hasSendonly || hasSendrecv
                const isViewer     = hasRecvonly

                /*  handle protocol based on mode  */
                if (self.params.mode === "r" && isPublisher)
                    /*  in read mode, accept WHIP publishers  */
                    await self.handleWHIP(res, body)
                else if (self.params.mode === "w" && isViewer)
                    /*  in write mode, accept WHEP viewers  */
                    await self.handleWHEP(res, body)
                else {
                    res.writeHead(403, { "Content-Type": "text/plain" })
                    res.end("Forbidden")
                }
            }
            else if (req.method === "DELETE" && resourceMatch) {
                /*  handle DELETE for connection teardown  */
                const resourceId = url.pathname.substring(self.params.path.length + 1)
                self.handleDELETE(res, resourceId)
            }
            else {
                /*  handle unknown requests  */
                res.writeHead(404, { "Content-Type": "text/plain" })
                res.end("Not Found")
            }
        })

        /*  start HTTP server  */
        await new Promise<void>((resolve) => {
            this.httpServer!.listen(listen.port, listen.host, () => {
                const mode = this.params.mode === "r" ? "WHIP" : "WHEP"
                this.log("info", `WebRTC ${mode} server listening on http://${listen.host}:${listen.port}${this.params.path}`)
                resolve()
            })
        })

        /*  create duplex stream  */
        const reads = new util.PromiseSet<void>()
        this.stream = new Stream.Duplex({
            writableObjectMode: true,
            readableObjectMode: true,
            decodeStrings:      false,
            highWaterMark:      1,
            write (chunk: SpeechFlowChunk, encoding, callback) {
                if (self.params.mode === "r") {
                    callback(new Error("write operation on read mode node"))
                    return
                }
                if (chunk.type !== "audio") {
                    callback(new Error("WebRTC node only supports audio type"))
                    return
                }
                if (self.peerConnections.size === 0) {
                    /*  silently drop if no viewers connected  */
                    callback()
                    return
                }
                self.bufferAndEncode(chunk)
                callback()
            },
            async final (callback) {
                await reads.awaitAll()
                callback()
            },
            read (size: number) {
                if (self.params.mode === "w") {
                    self.log("error", "read operation on write mode node")
                    this.push(null)
                    return
                }
                reads.add(self.chunkQueue!.read().then((chunk) => {
                    this.push(chunk, "binary")
                }).catch((err: Error) => {
                    self.log("warning", `read on chunk queue operation failed: ${err}`)
                    this.push(null)
                }))
            }
        })
    }

    /*  close node  */
    async close () {
        /*  close all peer connections  */
        for (const resourceId of Array.from(this.peerConnections.keys()))
            this.cleanupConnection(resourceId)

        /*  close HTTP server  */
        if (this.httpServer !== null) {
            await new Promise<void>((resolve, reject) => {
                this.httpServer!.close((err) => {
                    if (err) reject(err)
                    else     resolve()
                })
            }).catch((err: Error) => {
                this.log("warning", `failed to close HTTP server: ${err.message}`)
            })
            this.httpServer = null
        }

        /*  drain and clear chunk queue  */
        if (this.chunkQueue !== null) {
            this.chunkQueue.drain()
            this.chunkQueue = null
        }

        /*  cleanup codec instances  */
        this.opusEncoder = null
        this.opusDecoder = null
        this.pcmBuffer   = Buffer.alloc(0)

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
