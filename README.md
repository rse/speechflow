
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

**SpeechFlow** is a command-line interface based tool for establishing
a directed data flow graph of audio and text processing nodes. This
way, it allows to perform various speech processing tasks in a very
flexible and configurable way. The usual supported tasks are capturing
audio, generate narrations of text (aka text-to-speech), generate
transcriptions or subtitles for audio (aka speech-to-text), and generate
translations for audio (aka speech-to-speech).

**SpeechFlow** comes with built-in graph nodes for
local file I/O,
local audio device I/O,
remote WebSocket network I/O,
remote MQTT network I/O,
cloud-based [Deepgram](https://deepgram.com) speech-to-text conversion,
cloud-based [ElevenLabs](https://elevenlabs.io/) text-to-speech conversion,
cloud-based [DeepL](https://deepl.com) text-to-text translation,
cloud-based [OpenAI/GPT](https://openai.com) text-to-text translation (or spelling correction),
local [Ollama/Gemma](https://ollama.com) text-to-text translation (or spelling correction),
local [OPUS/ONNX](https://github.com/Helsinki-NLP/Opus-MT) text-to-text translation,
local [FFmpeg](https://ffmpeg.org/) speech-to-speech encoding,
local WAV speech-to-speech encoding,
local text-to-text formatting,
local text-to-text subtitle generation, and
local text or audio tracing.

Additional **SpeechFlow** graph nodes can be provided externally
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
  [-f|--file <file>]
  [-c|--config <id>@<yaml-config-file>]
  [<argument> [...]]
```

Processing Graph Examples
-------------------------

The following are examples of **SpeechFlow** processing graphs.
They can also be found in the sample [speechflow.yaml](./etc/speechflow.yaml) file.

- **Capturing**: Capture audio from microphone device into WAV audio file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") |
      wav(mode: "encode") |
          file(path: "capture.wav", mode: "w", type: "audio")
  ```

- **Pass-Through**: Pass-through audio from microphone device to speaker
  device and in parallel record it to WAV audio file:

  ```
  device(device: "wasapi:VoiceMeeter Out B1", mode: "r") | {
      wav(mode: "encode") |
          file(path: "capture.wav", mode: "w", type: "audio"),
      device(device: "wasapi:VoiceMeeter VAIO3 Input", mode: "w")
  }
  ```

- **Transcription**: Generate text file with German transcription of MP3 audio file:

  ```
  file(path: argv.0, mode: "r", type: "audio") |
      ffmpeg(src: "mp3", dst: "pcm") |
          deepgram(language: "de", key: env.SPEECHFLOW_DEEPGRAM_KEY) |
              format(width: 80) |
                  file(path: argv.1, mode: "w", type: "text")
  ```

- **Subtitling**: Generate text file with German subtitles of MP3 audio file:

  ```
  file(path: argv.0, mode: "r", type: "audio") |
      ffmpeg(src: "mp3", dst: "pcm") |
          deepgram(language: "de", key: env.SPEECHFLOW_DEEPGRAM_KEY) |
              subtitle(format: "vtt") |
                  file(path: argv.1, mode: "w", type: "text")
  ```

- **Speaking**: Generate audio file with English voice for a text file:

  ```
  file(path: argv.0, mode: "r", type: "text") |
      kokoro(language: "en") |
          wav(mode: "encode") |
              file(path: argv.1, mode: "w", type: "audio")
  ```

- **Ad-Hoc Translation**: Ad-Hoc text translation from German to English
  via stdin/stdout:

  ```
  file(path: "-", mode: "r", type: "text") |
      deepl(src: "de", dst: "en") |
          file(path: "-", mode: "w", type: "text")
  ```

- **Studio Translation**: Real-time studio translation from German to English,
  including the capturing of all involved inputs and outputs:

  ```
  device(device: "coreaudio:Elgato Wave:3", mode: "r") | {
      wav(mode: "encode") |
          file(path: "program-de.wav", mode: "w", type: "audio"),
      deepgram(key: env.SPEECHFLOW_DEEPGRAM_KEY, language: "de") | {
          format(width: 80) |
              file(path: "program-de.txt", mode: "w", type: "text"),
          deepl(key: env.SPEECHFLOW_DEEPL_KEY, src: "de", dst: "en") | {
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
  **file**,
  **device**,
  **websocket**,
  **mqtt**.
- Audio-to-Audio nodes:
  **ffmpeg**,
  **wav**,
  **mute**.
  **meter**.
  **vad**.
- Audio-to-Text nodes:
  **deepgram**.
- Text-to-Text nodes:
  **deepl**,
  **openai**,
  **ollama**,
  **transformers**,
  **subtitle**,
  **format**.
- Text-to-Audio nodes:
  **elevenlabs**.
- Any-to-Any nodes:
  **trace**.

### Input/Output Nodes:

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

### Audio-to-Audio Nodes:

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

- Node: **mute**<br/>
  Purpose: **volume muting node**<br/>
  Example: `mute()`
  Notice: this node has to be externally controlled via REST/WebSockets!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |

- Node: **meter**<br/>
  Purpose: **Loudness metering node**<br/>
  Example: `meter(250)`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **interval**  | 0 | 250 | *none* |

- Node: **vad**<br/>
  Purpose: **Voice Audio Detection (VAD) node**<br/>
  Example: `vad()`

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **mode**               | *none* | "unplugged" | `/^(?:silenced|unplugged)$/` |
  | **posSpeechThreshold** | *none* | 0.50  | *none* |
  | **negSpeechThreshold** | *none* | 0.35  | *none* |
  | **minSpeechFrames**    | *none* | 2     | *none* |
  | **redemptionFrames**   | *none* | 12    | *none* |
  | **preSpeechPadFrames** | *none* | 1     | *none* |

### Audio-to-Text Nodes:

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
  | **key**      | *none*    | env.SPEECHFLOW\_DEEPGRAM\_KEY | *none* |
  | **keyAdm**   | *none*    | env.SPEECHFLOW\_DEEPGRAM\_KEY\_ADM | *none* |
  | **model**    | 0         | "nova-3" | *none* |
  | **version**  | 1         | "latest" | *none* |
  | **language** | 2         | "multi"  | *none* |

### Text-to-Text Nodes:

- Node: **deepl**<br/>
  Purpose: **DeepL Text-to-Text translation**<br/>
  Example: `deepl(src: "de", dst: "en")`<br/>
  Notice: this node requires an API key!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_DEEPL\_KEY | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **openai**<br/>
  Purpose: **OpenAI/GPT Text-to-Text translation and spelling correction**<br/>
  Example: `openai(src: "de", dst: "en")`<br/>
  Notice: this node requires an OpenAI API key!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **api**      | *none*    | "https://api.openai.com" | `/^https?:\/\/.+?:\d+$/` |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |
  | **key**      | *none*    | env.SPEECHFLOW\_OPENAI\_KEY | *none* |
  | **model**    | *none*    | "gpt-4o-mini" | *none* |

- Node: **ollama**<br/>
  Purpose: **Ollama/Gemma Text-to-Text translation and spelling correction**<br/>
  Example: `ollama(src: "de", dst: "en")`<br/>
  Notice: this node requires the Ollama API!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **api**      | *none*    | "http://127.0.0.1:11434" | `/^https?:\/\/.+?:\d+$/` |
  | **model**    | *none*    | "gemma3:4b-it-q4_K_M" | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **transformers**<br/>
  Purpose: **Transformers Text-to-Text translation**<br/>
  Example: `transformers(src: "de", dst: "en")`<br/>

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement      |
  | ------------ | --------- | -------- | ---------------- |
  | **model**    | *none*    | "OPUS"   | `/^(?:OPUS|SmolLM3)$/` |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

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

### Text-to-Audio Nodes:

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
  | **key**      | *none*    | env.SPEECHFLOW\_ELEVENLABS\_KEY | *none* |
  | **voice**    | 0         | "Brian"  | *none* |
  | **language** | 1         | "de"     | *none* |

- Node: **kokoro**<br/>
  Purpose: **Kokoro Text-to-Speech conversion**<br/>
  Example: `kokoro(language: "en")`<br/>
  Notice: this currently support English language only!

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | audio       |

  | Parameter    | Position  | Default  | Requirement |
  | ------------ | --------- | -------- | ----------- |
  | **voice**    | 0         | "Aoede"  | `/^(?:Aoede|Heart|Puck|Fenrir)$/` |
  | **language** | 1         | "en"     | `/^en$/`    |
  | **speed**    | 2         | 1.25     | 1.0...1.30  |

### Any-to-Any Nodes:

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

**SpeechFlow** makes available to **FlowLink** all **SpeechFlow** nodes as
`node`, the CLI arguments under the array `variable` named `argv`, and all
environment variables under the object `variable` named `env`.

History
-------

**Speechflow**, as a technical cut-through, was initially created in
March 2024 for use in the msg Filmstudio context. It was later refined
into a more complete toolkit in April 2025 and this way the first time
could be used in production. It was fully refactored in July 2025 in
order to support timestamps in the streams processing.

Copyright & License
-------------------

Copyright &copy; 2024-2025 [Dr. Ralf S. Engelschall](mailto:rse@engelschall.com)<br/>
Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)

