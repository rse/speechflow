/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  standard dependencies  */
import path              from "node:path"

/*  external dependencies  */
import CLIio             from "cli-io"
import yargs             from "yargs"
import { hideBin }       from "yargs/helpers"
import jsYAML            from "js-yaml"
import dotenvx           from "@dotenvx/dotenvx"
import syspath           from "syspath"
import chalk             from "chalk"

/*  internal dependencies  */
import * as util         from "./speechflow-util"
import pkg               from "../../package.json"

/*  command-line options  */
export interface CLIOptions {
    V: boolean
    S: boolean
    v: string
    a: string
    p: number
    C: string
    d: string
    o: string
    e: string
    f: string
    c: string
    _: (string | number)[]
}

export class CLIContext {
    public cli:    CLIio      | null = null
    public args:   CLIOptions | null = null
    public config: string     | null = null
    public debug                     = false

    /*  type guard for initialization  */
    isInitialized (): this is CLIContext & { cli: CLIio; args: CLIOptions; config: string } {
        return this.cli !== null && this.args !== null && this.config !== null
    }

    /*  initialization of CLI  */
    async init (): Promise<void> {
        /*  determine system paths  */
        const { dataDir } = syspath({
            appName: "speechflow",
            dataDirAutoCreate: true
        })

        /*  parse command-line arguments  */
        const coerce = (arg: string) => Array.isArray(arg) ? arg[arg.length - 1] : arg
        this.args = await yargs()
            /* eslint @stylistic/indent: off */
            .usage(
                "Usage: $0 " +
                "[-h|--help] " +
                "[-V|--version] " +
                "[-S|--status] " +
                "[-v|--verbose <level>] " +
                "[-a|--address <ip-address>] " +
                "[-p|--port <tcp-port>] " +
                "[-C|--cache <directory>] " +
                "[-d|--dashboard <type>:<id>:<name>[,...]] " +
                "[-o|--osc <ip-address>:<udp-port>] " +
                "[-e|--expression <expression>] " +
                "[-f|--file <file>] " +
                "[-c|--config <id>@<yaml-config-file>] " +
                "[<argument> [...]]"
            )
            .version(false)
            .option("V", {
                alias:    "version",
                type:     "boolean",
                array:    false,
                coerce,
                default:  false,
                describe: "show program version information"
            })
            .option("S", {
                alias:    "status",
                type:     "boolean",
                array:    false,
                coerce,
                default:  false,
                describe: "show one-time status of nodes"
            })
            .option("v", {
                alias:    "log-level",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "warning",
                describe: "level for verbose logging ('none', 'error', 'warning', 'info', 'debug')"
            })
            .option("a", {
                alias:    "address",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "0.0.0.0",
                describe: "IP address for REST/WebSocket API"
            })
            .option("p", {
                alias:    "port",
                type:     "number",
                array:    false,
                coerce,
                nargs:    1,
                default:  8484,
                describe: "TCP port for REST/WebSocket API"
            })
            .option("C", {
                alias:    "cache",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  path.join(dataDir, "cache"),
                describe: "directory for cached files (primarily AI model files)"
            })
            .option("d", {
                alias:    "dashboard",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "",
                describe: "list of dashboard block types and names"
            })
            .option("o", {
                alias:    "osc",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "",
                describe: "OSC/UDP endpoint to send dashboard information"
            })
            .option("e", {
                alias:    "expression",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "",
                describe: "FlowLink expression string"
            })
            .option("f", {
                alias:    "file",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "",
                describe: "FlowLink expression file"
            })
            .option("c", {
                alias:    "config",
                type:     "string",
                array:    false,
                coerce,
                nargs:    1,
                default:  "",
                describe: "FlowLink expression reference into YAML file (in format <id>@<file>)"
            })
            .help("h", "show usage help")
            .alias("h", "help")
            .showHelpOnFail(true)
            .strict()
            .demand(0)
            .parse(hideBin(process.argv)) as CLIOptions

        /*  short-circuit version request  */
        if (this.args.V) {
            process.stderr.write(`SpeechFlow ${pkg["x-stdver"]} (${pkg["x-release"]}) <${pkg.homepage}>\n`)
            process.stderr.write(`${pkg.description}\n`)
            process.stderr.write(`Copyright (c) 2024-2025 ${pkg.author.name} <${pkg.author.url}>\n`)
            process.stderr.write(`Licensed under ${pkg.license} <http://spdx.org/licenses/${pkg.license}.html>\n`)
            process.exit(0)
        }

        /*  establish CLI environment  */
        this.cli = new CLIio({
            encoding:  "utf8",
            logLevel:  this.args.v,
            logTime:   true,
            logPrefix: pkg.name
        })
        if (this.args.v.match(/^(?:info|debug)$/))
            this.debug = true

        /*  provide startup information  */
        this.cli.log("info", `starting SpeechFlow ${pkg["x-stdver"]} (${pkg["x-release"]})`)

        /*  load .env files  */
        const result = dotenvx.config({
            encoding: "utf8",
            ignore:   [ "MISSING_ENV_FILE" ],
            quiet:    true
        })
        if (result?.parsed !== undefined)
            for (const key of Object.keys(result.parsed))
                this.cli.log("info", `loaded environment variable "${key}" from ".env" files`)

        /*  sanity check configuration situation  */
        let n = 0
        if (typeof this.args.e === "string" && this.args.e !== "") n++
        if (typeof this.args.f === "string" && this.args.f !== "") n++
        if (typeof this.args.c === "string" && this.args.c !== "") n++
        if (n === 0)
            throw new Error("need at least one FlowLink specification source (use one of the options -e, -f or -c)")
        else if (n !== 1)
            throw new Error("cannot use more than one FlowLink specification source (use only one of the options -e, -f or -c)")

        /*  read configuration  */
        if (typeof this.args.e === "string" && this.args.e !== "")
            this.config = this.args.e
        else if (typeof this.args.f === "string" && this.args.f !== "")
            this.config = await this.cli.input(this.args.f, { encoding: "utf8" })
        else if (typeof this.args.c === "string" && this.args.c !== "") {
            const m = this.args.c.match(/^(.+?)@(.+)$/)
            if (m === null)
                throw new Error("invalid configuration file specification (expected \"<id>@<yaml-config-file>\")")
            const [ , id, file ] = m
            const yaml = await this.cli.input(file, { encoding: "utf8" })
            const obj: any = util.run("parsing YAML configuration", () => jsYAML.load(yaml))
            if (obj[id] === undefined)
                throw new Error(`no such id "${id}" found in configuration file "${file}"`)
            this.config = obj[id] as string
        }
    }

    /*  utility function for handling a top-level error  */
    handleTopLevelError (err: Error): never {
        if (this.cli !== null) {
            if (this.debug)
                this.cli.log("error", `${err.message}\n${err.stack}`)
            else
                this.cli.log("error", `${err.message}`)
        }
        else {
            if (this.debug)
                process.stderr.write(`${pkg.name}: ${chalk.red("ERROR")}: ${err.message}\n${err.stack}\n`)
            else
                process.stderr.write(`${pkg.name}: ${chalk.red("ERROR")}: ${err.message}`)
        }
        process.exit(1)
    }
}