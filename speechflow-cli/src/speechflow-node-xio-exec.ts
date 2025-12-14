/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import Stream                     from "node:stream"

/*  external dependencies  */
import { execa, type Subprocess, type Options } from "execa"
import shellParser                from "shell-parser"

/*  internal dependencies  */
import SpeechFlowNode             from "./speechflow-node"
import * as util                  from "./speechflow-util"

/*  SpeechFlow node for external command execution  */
export default class SpeechFlowNodeXIOExec extends SpeechFlowNode {
    /*  declare official node name  */
    public static name = "xio-exec"

    /*  internal state  */
    private subprocess: Subprocess | null = null

    /*  construct node  */
    constructor (id: string, cfg: { [ id: string ]: any }, opts: { [ id: string ]: any }, args: any[]) {
        super(id, cfg, opts, args)

        /*  declare node configuration parameters  */
        this.configure({
            command:    { type: "string", pos: 0, val: "" },
            mode:       { type: "string", pos: 1, val: "r",     match: /^(?:r|w|rw)$/ },
            type:       { type: "string", pos: 2, val: "audio", match: /^(?:audio|text)$/ },
            chunkAudio: { type: "number",         val: 200,     match: (n: number) => n >= 10 && n <= 1000 },
            chunkText:  { type: "number",         val: 65536,   match: (n: number) => n >= 1024 && n <= 131072 }
        })

        /*  sanity check parameters  */
        if (this.params.command === "")
            throw new Error("required parameter \"command\" has to be given")

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
        /*  determine how many bytes we need per chunk when
            the chunk should be of the required duration/size  */
        const highWaterMarkAudio = (
            this.config.audioSampleRate *
            (this.config.audioBitDepth / 8)
        ) / (1000 / this.params.chunkAudio)
        const highWaterMarkText = this.params.chunkText

        /*  parse command into executable and arguments
            (SECURITY: caller must ensure command parameter is properly validated
            and does not contain untrusted user input to prevent command injection)  */
        const cmdParts = shellParser(this.params.command)
        if (cmdParts.length === 0)
            throw new Error("failed to parse command: no executable found")

        /*  warn about potentially dangerous shell metacharacters  */
        if (/[;&|`$()<>]/.test(this.params.command))
            this.log("warning", "command contains shell metacharacters -- ensure input is trusted")
        const executable = cmdParts[0]
        const args = cmdParts.slice(1)

        /*  determine subprocess options  */
        const encoding = (this.params.type === "text" ?
            this.config.textEncoding : "buffer") as Options["encoding"]

        /*  spawn subprocess  */
        this.log("info", `executing command: ${this.params.command}`)
        this.subprocess = execa(executable, args, {
            buffer: false,
            encoding,
            ...(this.params.mode === "rw" ? { stdin: "pipe",   stdout: "pipe"   } : {}),
            ...(this.params.mode === "r"  ? { stdin: "ignore", stdout: "pipe"   } : {}),
            ...(this.params.mode === "w"  ? { stdin: "pipe",   stdout: "ignore" } : {})
        })

        /*  handle subprocess errors  */
        this.subprocess.on("error", (err) => {
            this.log("error", `subprocess error: ${err.message}`)
            this.emit("error", err)
            if (this.stream !== null)
                this.stream.emit("error", err)
        })

        /*  handle subprocess exit  */
        this.subprocess.on("exit", (code, signal) => {
            if (code !== 0 && code !== null)
                this.log("warning", `subprocess exited with code ${code}`)
            else if (signal)
                this.log("warning", `subprocess terminated by signal ${signal}`)
            else
                this.log("info", "subprocess terminated gracefully")
        })

        /*  determine high water mark based on type  */
        const highWaterMark = this.params.type === "audio" ? highWaterMarkAudio : highWaterMarkText

        /*  configure stream encoding  */
        if (this.subprocess.stdout && this.params.type === "text")
            this.subprocess.stdout.setEncoding(this.config.textEncoding)
        if (this.subprocess.stdin)
            this.subprocess.stdin.setDefaultEncoding(this.params.type === "text" ?
                this.config.textEncoding : "binary")

        /*  dispatch according to mode  */
        if (this.params.mode === "rw") {
            /*  bidirectional mode: both stdin and stdout  */
            this.stream = Stream.Duplex.from({
                readable: this.subprocess.stdout,
                writable: this.subprocess.stdin
            })
            const wrapper1 = util.createTransformStreamForWritableSide(this.params.type, highWaterMark)
            const wrapper2 = util.createTransformStreamForReadableSide(
                this.params.type, () => this.timeZero, highWaterMark)
            this.stream = Stream.compose(wrapper1, this.stream, wrapper2)
        }
        else if (this.params.mode === "r") {
            /*  read-only mode: stdout only  */
            const wrapper = util.createTransformStreamForReadableSide(
                this.params.type, () => this.timeZero, highWaterMark)
            this.stream = Stream.compose(this.subprocess.stdout!, wrapper)
        }
        else if (this.params.mode === "w") {
            /*  write-only mode: stdin only  */
            const wrapper = util.createTransformStreamForWritableSide(
                this.params.type, highWaterMark)
            this.stream = Stream.compose(wrapper, this.subprocess.stdin!)
        }
    }

    /*  close node  */
    async close () {
        /*  terminate subprocess  */
        if (this.subprocess !== null) {
            /*  gracefully end stdin if in write or read/write mode  */
            if ((this.params.mode === "w" || this.params.mode === "rw") && this.subprocess.stdin &&
                !this.subprocess.stdin.destroyed && !this.subprocess.stdin.writableEnded) {
                await Promise.race([
                    new Promise<void>((resolve, reject) => {
                        this.subprocess!.stdin!.end((err?: Error) => {
                            if (err) reject(err)
                            else     resolve()
                        })
                    }),
                    util.timeout(2000)
                ]).catch((err: unknown) => {
                    const error = util.ensureError(err)
                    this.log("warning", `failed to gracefully close stdin: ${error.message}`)
                })
            }

            /*  wait for subprocess to exit gracefully  */
            await Promise.race([
                this.subprocess,
                util.timeout(5000, "subprocess exit timeout")
            ]).catch(async (err: unknown) => {
                /*  force kill with SIGTERM  */
                const error = util.ensureError(err)
                if (error.message.includes("timeout")) {
                    this.log("warning", "subprocess did not exit gracefully, forcing termination")
                    this.subprocess!.kill("SIGTERM")
                    return Promise.race([
                        this.subprocess,
                        util.timeout(2000)
                    ])
                }
            }).catch(async () => {
                /*  force kill with SIGKILL  */
                this.log("warning", "subprocess did not respond to SIGTERM, forcing SIGKILL")
                this.subprocess!.kill("SIGKILL")
                return Promise.race([
                    this.subprocess,
                    util.timeout(1000)
                ])
            }).catch(() => {
                this.log("error", "subprocess did not terminate even after SIGKILL")
            })

            /*  remove event listeners to prevent memory leaks  */
            this.subprocess.removeAllListeners("error")
            this.subprocess.removeAllListeners("exit")

            this.subprocess = null
        }

        /*  shutdown stream  */
        if (this.stream !== null) {
            await util.destroyStream(this.stream)
            this.stream = null
        }
    }
}
