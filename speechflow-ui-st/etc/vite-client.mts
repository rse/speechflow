/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import path              from "node:path"
import * as Vite         from "vite"
import VuePlugin         from "@vitejs/plugin-vue"
import YAMLPlugin        from "@rollup/plugin-yaml"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import SvgLoader         from "vite-svg-loader"
import { mkdirp }        from "mkdirp"

export default Vite.defineConfig(({ command, mode }) => ({
    logLevel: "info",
    base: "",
    root: "src",
    assetsInclude: [ "index.yaml" ],
    plugins: [
        VuePlugin(),
        YAMLPlugin(),
        SvgLoader(),
        nodePolyfills({
            include: [ "events", "stream", "path", "fs", "os" ],
            globals: { Buffer: true }
        })
    ],
    css: {
        devSourcemap: mode === "development"
    },
    build: {
        target:                 "es2022",
        outDir:                 "../dst",
        assetsDir:              "",
        emptyOutDir:            (mode === "production"),
        chunkSizeWarningLimit:  8000,
        assetsInlineLimit:      0,
        sourcemap:              (mode === "development"),
        minify:                 (mode === "production"),
        reportCompressedSize:   false,
        rollupOptions: {
            input: "src/index.html",
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "[name].js",
                assetFileNames: (assetInfo) => {
                    let spec = "[name].[ext]"
                    if (assetInfo.names[0].match(/\.(?:ttf|woff2?|eot)$/))
                        spec = `app-font-${assetInfo.names[0]}`
                    return spec
                }
            },
            onwarn: (entry, next) => {
                if (entry.message.match(/node_modules.+Use of eval in/))
                    return
                else
                    return next(entry)
            }
        }
    }
}))

