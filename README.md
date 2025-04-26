
<img src="https://raw.githubusercontent.com/rse/speechflow/master/src/speechflow-logo.svg" width="400" align="right" alt=""/>

SpeechFlow
==========

**Speech Processing Flow Graph**

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)
[![github (project stdver)](https://img.shields.io/github/package-json/x-stdver/rse/speechflow?logo=github&label=project%20stdver&color=%234477aa&cacheSeconds=900)](https://github.com/rse/speechflow)
[![github (project release)](https://img.shields.io/github/package-json/x-release/rse/speechflow?logo=github&label=project%20release&color=%234477aa&cacheSeconds=900)](https://github.com/rse/speechflow)

About
-----

**SpeechFlow** is a command-line interface based tool for establishing a
directed data flow graph of audio and text processing nodes. This way it
allows to perform various speech processing tasks in a flexible way.

Installation
------------

```
$ npm install -g speechflow
```

Usage
-----

```
$ speechflow
  [-h|--help]
  [-V|--version]
  [-v|--verbose <level>]
  [-e|--expression <expression>]
  [-f|--expression-file <expression-file>]
  [-c|--config <key>@<yaml-config-file>]
  [<argument> [...]]
```

Processing Graph Examples
-------------------------

- Capture audio from microphone to file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") |
  file(path: "capture.pcm", mode: "w", type: "audio")
  ```

- Generate audio file with narration of text file:

  ```
  file(path: argv.0, mode: "r", type: "audio") |
  deepgram(language: "en") |
  file(path: argv.1, mode: "w", type: "text")
  ```

- Translate stdin to stdout:

  ```
  file(path: "-", mode: "r", type: "text") |
  deepl(src: "de", dst: "en-US") |
  file(path: "-", mode: "w", type: "text")
  ```

- Pass-through audio from microphone to speaker and in parallel record it to file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") | {
      file(path: "capture.pcm", mode: "w", type: "audio"),
      device(device: "wasapi:VoiceMeeter VAIO3 Input", mode: "w")
  }
  ```

- Real-time translation from german to english, including capturing of all inputs and outputs:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") | {
      file(path: "translation-audio-de.pcm", mode: "w", type: "audio"),
      deepgram(language: "de") |
      file(path: "translation-text-de.txt", mode: "w", type: "text")
  } | {
      deepl(src: "de", dst: "en-US") |
      file(path: "translation-text-en.txt", mode: "w", type: "text")
  } | {
      elevenlabs(language: "en") | {
          file(path: "translation-audio-en.pcm", mode: "w", type: "audio"),
          device(device: "wasapi:VoiceMeeter VAIO3 Input", mode: "w")
      }
  }
  ```

Processing Node Types
---------------------

Currently **SpeechFlow** provides the following processing nodes:

- Node:    **file**<br/>
  Purpose: **File and StdIO source/sink**<br/>
  Example: `file(path: "capture.pcm", mode: "w", type: "audio")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter  | Position  | Default  | Requirement           |
  | ---------- | --------- | -------- | --------------------- |
  | **path**   | 0         | *none*   | *none*                |
  | **mode**   | 1         | "r"      | `/^(?:r\|w\|rw)$/`    |
  | **type**   | 2         | "audio"  | `/^(?:audio\|text)$/` |

- Node: **websocket**<br/>
  Purpose: **WebSocket source/sink**<br/>
  Example: `websocket(connect: "ws://127.0.0.1:12345". type: "text")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter   | Position  | Default  | Requirement           |
  | ----------- | --------- | -------- | --------------------- |
  | **listen**  | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+))$/` |
  | **connect** | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/` |
  | **type**    | *none*    | "audio"  | `/^(?:audio\|text)$/` |

- Node: **device**<br/>
  Purpose: **Microphone/speaker device source/sink**<br/>
  Example: `device(device: "wasapi:VoiceMeeter Out B1", mode: "r")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement        |
  | ----------- | --------- | -------- | ------------------ |
  | **device**  | 0         | *none*   | `/^(.+?):(.+)$/`   |
  | **mode**    | 1         | "rw"     | `/^(?:r\|w\|rw)$/` |

- Node: **deepgram**<br/>
  Purpose: **Deepgram Speech-to-Text conversion**<br/>
  Example: `deepgram(language: "de")`<br/>
  Notice: this node requires an API key!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_KEY\_DEEPGRAM | *none* |
  | **model**    | 0         | "nova-2" | *none* |
  | **version**  | 1         | "latest" | *none* |
  | **language** | 2         | "de"     | *none* |

- **deepl**: DeepL Text-to-Text translation (input: text, output: text).
- **elevenlabs**: ElevenLabs Text-to-Speech conversion (input: text, output: audio).

History
-------

**Speechflow**, as a technical cut-through, was initially created in
March 2024 for use in the msg Filmstudio context. It was later refined
into a more complete toolkit in April 2025 and this way the first time
could be used in production.

Copyright & License
-------------------

Copyright &copy; 2024-2025 [Dr. Ralf S. Engelschall](mailto:rse@engelschall.com)<br/>
Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)

