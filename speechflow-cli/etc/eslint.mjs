/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

import pluginJs      from "@eslint/js"
import pluginStd     from "neostandard"
import pluginN       from "eslint-plugin-n"
import pluginImport  from "eslint-plugin-import"
import pluginPromise from "eslint-plugin-promise"
import pluginTS      from "typescript-eslint"
import globals       from "globals"
import parserTS      from "@typescript-eslint/parser"
import oxlint        from "eslint-plugin-oxlint"

export default [
    pluginJs.configs.recommended,
    ...pluginTS.configs.strict,
    ...pluginTS.configs.stylistic,
    ...pluginStd({
        ignores: pluginStd.resolveIgnoresFromGitignore()
    }),
    {
        plugins: {
            "n":       pluginN,
            "import":  pluginImport,
            "promise": pluginPromise
        },
        files:   [ "**/*.ts" ],
        ignores: [ "dst/" ],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType:  "module",
            parser: parserTS,
            parserOptions: {
                extraFileExtensions: [],
                ecmaFeatures: {
                    jsx: false
                }
            },
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.commonjs,
                ...globals.worker,
                ...globals.serviceworker,
                "BufferEncoding": "readonly"
            }
        },
        rules: {
            "curly":                                              "off",
            "require-atomic-updates":                             "off",
            "dot-notation":                                       "off",
            "no-labels":                                          "off",
            "no-useless-constructor":                             "off",
            "no-dupe-class-members":                              "off",
            "valid-typeof":                                       "off",

            "@stylistic/indent":                                  [ "error", 4, { SwitchCase: 1 } ],
            "@stylistic/linebreak-style":                         [ "error", "unix" ],
            "@stylistic/semi":                                    [ "error", "never" ],
            "@stylistic/operator-linebreak":                      [ "error", "after", { overrides: { "&&": "before", "||": "before", ":": "after" } } ],
            "@stylistic/brace-style":                             [ "error", "stroustrup", { allowSingleLine: true } ],
            "@stylistic/quotes":                                  [ "error", "double" ],

            "@stylistic/no-multi-spaces":                         "off",
            "@stylistic/no-multiple-empty-lines":                 "off",
            "@stylistic/key-spacing":                             "off",
            "@stylistic/object-property-newline":                 "off",
            "@stylistic/space-in-parens":                         "off",
            "@stylistic/array-bracket-spacing":                   "off",
            "@stylistic/lines-between-class-members":             "off",
            "@stylistic/multiline-ternary":                       "off",
            "@stylistic/quote-props":                             "off",

            "@typescript-eslint/no-empty-function":               "off",
            "@typescript-eslint/no-explicit-any":                 "off",
            "@typescript-eslint/no-unused-vars":                  "off",
            "@typescript-eslint/ban-ts-comment":                  "off",
            "@typescript-eslint/no-this-alias":                   "off",
            "@typescript-eslint/no-non-null-assertion":           "off",
            "@typescript-eslint/consistent-type-definitions":     "off",
            "@typescript-eslint/array-type":                      "off",
            "@typescript-eslint/no-extraneous-class":             "off",
            "@typescript-eslint/consistent-indexed-object-style": "off",
            "@typescript-eslint/adjacent-overload-signatures":    "off"
        }
    },
    ...oxlint.buildFromOxlintConfigFile("etc/oxlint.jsonc")
]

