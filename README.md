
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
directed data flow graph of audio and text processing nodes. This way,
it allows to perform various speech processing tasks in a flexible way.

**SpeechFlow** comes with built-in graph nodes for
local file I/O,
local audio device I/O,
remote WebSocket network I/O,
remote MQTT network I/O,
cloud-based [Deepgram](https://deepgram.com) speech-to-text conversion,
cloud-based [DeepL](https://deepl.com) text-to-text translation,
local [Gemma/Ollama](https://ollama.com/library/gemma3) text-to-text translation,
local [Gemma/Ollama](https://ollama.com/library/gemma3) text-to-text spelling correction,
local [OPUS/ONNX](https://github.com/Helsinki-NLP/Opus-MT) text-to-text translation,
cloud-based [ElevenLabs](https://elevenlabs.io/) text-to-speech conversion,
and local [FFmpeg](https://ffmpeg.org/) speech-to-speech encoding.
Additional SpeechFlow graph nodes can be provided externally
by NPM packages named `speechflow-node-xxx` which expose a class
derived from the exported `SpeechFlowNode` class of the `speechflow` package.

**SpeechFlow** is written in TypeScript and
ships as an installable package for the Node Package Manager (NPM).

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

- **Capturing**: Capture audio from microphone to file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") |
      file(path: "capture.pcm", mode: "w", type: "audio")
  ```

- **Pass-Through**: Pass-through audio from microphone to speaker and in parallel record it to file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") | {
      file(path: "capture.pcm", mode: "w", type: "audio"),
      device(device: "wasapi:VoiceMeeter VAIO3 Input", mode: "w")
  }
  ```

- **Narration**: Generate audio file with narration of text file:

  ```
  file(path: argv.0, mode: "r", type: "audio") |
      deepgram(language: "en") |
          file(path: argv.1, mode: "w", type: "text")
  ```

- **Translation**: Translate stdin to stdout:

  ```
  file(path: "-", mode: "r", type: "text") |
      deepl(src: "de", dst: "en-US") |
          file(path: "-", mode: "w", type: "text")
  ```

- **Translation**: Real-time translation from german to english, including capturing of all inputs and outputs:

  ```
  device(device: "coreaudio:Elgato Wave:3", mode: "r") | {
      wav(mode: "encode") |
          file(path: "program-de.wav", mode: "w", type: "audio"),
      deepgram(key: env.SPEECHFLOW_KEY_DEEPGRAM, language: "de") | {
          format(width: 80) |
              file(path: "program-de.txt", mode: "w", type: "text"),
          deepl(key: env.SPEECHFLOW_KEY_DEEPL, src: "de", dst: "en-US") | {
              format(width: 80) |
                  file(path: "program-en.txt", mode: "w", type: "text"),
              subtitle(format: "vtt") | {
                  file(path: "program-en.vtt", mode: "w", type: "text"),
                  mqtt(url: "mqtt://10.1.0.10:1883",
                      username: env.SPEECHFLOW_MQTT_USER,
                      password: env.SPEECHFLOW_MQTT_PASS,
                      topicWrite: "stream/studio/sender")
              },
              subtitle(format: "srt") |
                  file(path: "program-en.srt", mode: "w", type: "text"),
              elevenlabs(voice: "Mark", speed: 1.05, language: "en") | {
                  wav(mode: "encode") |
                      file(path: "program-en.wav", mode: "w", type: "audio"),
                  device(device: "coreaudio:USBAudio2.0", mode: "w")
              }
          }
      }
  }
  ```

Processing Node Types
---------------------

First a short overview of the available processing nodes:

- Input/Output nodes:
  **file**, **device**, **websocket**, **mqtt**.

- Converter nodes:
  **deepgram**,
  **deepl**, **gemma**, **opus**,
  **elevenlabs**,
  **wav**, **ffmpeg**,
  **subtitle**,
  **format**,
  **trace**.

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
  Example: `websocket(connect: "ws://127.0.0.1:12345", type: "text")`
  Notice: this node requires a peer WebSocket service!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter   | Position  | Default  | Requirement           |
  | ----------- | --------- | -------- | --------------------- |
  | **listen**  | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+))$/` |
  | **connect** | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/` |
  | **type**    | *none*    | "audio"  | `/^(?:audio\|text)$/` |

- Node: **mqtt**<br/>
  Purpose: **MQTT sink**<br/>
  Example: `mqtt(url: "mqtt://127.0.0.1:1883", username: "foo", password: "bar", topic: "quux")`
  Notice: this node requires a peer MQTT broker!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | none        |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **url**      | 0         | *none*   | `/^(?:\|(?:ws|mqtt):\/\/(.+?):(\d+))$/` |
  | **username** | 1         | *none*   | `/^.+$/` |
  | **password** | 2         | *none*   | `/^.+$/` |
  | **topic**    | 3         | *none*   | `/^.+$/` |

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

- Node: **wav**<br/>
  Purpose: **WAV audio format conversion**<br/>
  Example: `wav(mode: "encode")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **mode**    | 0         | "encode" | `/^(?:encode\|decode)$/` |

- Node: **ffmpeg**<br/>
  Purpose: **FFmpeg audio format conversion**<br/>
  Example: `ffmpeg(src: "pcm", dst: "mp3")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement        |
  | ----------- | --------- | -------- | ------------------ |
  | **src**     | 0         | "pcm"    | `/^(?:pcm\|wav\|mp3\|opus)$/` |
  | **dst**     | 1         | "wav"    | `/^(?:pcm\|wav\|mp3\|opus)$/` |

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

- Node: **whisper**<br/>
  Purpose: **OpenAI Whisper Speech-to-Text conversion**<br/>
  Example: `whisper(language: "de")`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | text        |

  | Parameter    | Position  | Default          | Requirement        |
  | ------------ | --------- | ---------------- | ------------------ |
  | **language** | 0         | "en"             | *none* |
  | **model**    | 1         | "v3-large-turbo" | *none* |

- Node: **deepl**<br/>
  Purpose: **DeepL Text-to-Text translation**<br/>
  Example: `deepl(src: "de", dst: "en-US")`<br/>
  Notice: this node requires an API key!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_KEY\_DEEPL | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en-US)$/` |
  | **dst**      | 1         | "en-US"  | `/^(?:de\|en-US)$/` |

- Node: **subtitle**<br/>
  Purpose: **SRT/VTT Subtitle Generation**<br/>
  Example: `subtitle(format: "srt")`<br/>

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **format**   | *none*    | "srt"    | /^(?:srt\|vtt)$/   |

- Node: **gemma**<br/>
  Purpose: **Google Gemma Text-to-Text translation and spelling correction**<br/>
  Example: `gemma(src: "de", dst: "en")`<br/>
  Notice; this node requires the Ollama API!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **url**      | *none*    | "http://127.0.0.1:11434" | `/^https?:\/\/.+?:\d+$/` |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **opus**<br/>
  Purpose: **OPUS Text-to-Text translation**<br/>
  Example: `deepl(src: "de", dst: "en")`<br/>

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement      |
  | ------------ | --------- | -------- | ---------------- |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **elevenlabs**<br/>
  Purpose: **ElevenLabs Text-to-Speech conversion**<br/>
  Example: `elevenlabs(language: "en")`<br/>
  Notice: this node requires an API key!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | audio       |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_KEY\_ELEVENLABS | *none* |
  | **voice**    | 0         | "Brian"  | *none* |
  | **language** | 1         | "de"     | *none* |

- Node: **format**<br/>
  Purpose: **text paragraph formatting**<br/>
  Example: `format(width: 80)`<br/>

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **width**    | 0         | 80       | *none*                |

- Node: **trace**<br/>
  Purpose: **data flow tracing**<br/>
  Example: `trace(type: "audio")`<br/>

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **type**     | 0         | "audio"  | `/^(?:audio\|text)$/` |
  | **name**     | 1         | *none*   | *none*                |

Graph Expression Language
-------------------------

The **SpeechFlow** graph expression language is based on
[**FlowLink**](https://npmjs.org/flowlink), which itself has a language
following the following BNF-style grammar:

```
expr             ::= parallel
                   | sequential
                   | node
                   | group
parallel         ::= sequential ("," sequential)+
sequential       ::= node ("|" node)+
node             ::= id ("(" (param ("," param)*)? ")")?
param            ::= array | object | variable | template | string | number | value
group            ::= "{" expr "}"
id               ::= /[a-zA-Z_][a-zA-Z0-9_-]*/
variable         ::= id
array            ::= "[" (param ("," param)*)? "]"
object           ::= "{" (id ":" param ("," id ":" param)*)? "}"
template         ::= "`" ("${" variable "}" / ("\\`"|.))* "`"
string           ::= /"(\\"|.)*"/
                   | /'(\\'|.)*'/
number           ::= /[+-]?/ number-value
number-value     ::= "0b" /[01]+/
                   | "0o" /[0-7]+/
                   | "0x" /[0-9a-fA-F]+/
                   | /[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?/
                   | /[0-9]+/
value            ::= "true" | "false" | "null" | "NaN" | "undefined"
```

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

