
<img src="https://raw.githubusercontent.com/rse/speechflow/master/speechflow-cli/src/speechflow-logo.svg" width="400" align="right" alt=""/>

SpeechFlow
==========

**Speech Processing Flow Graph**

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)
[![github (project stdver)](https://img.shields.io/github/package-json/x-stdver/rse/speechflow?logo=github&label=project%20stdver&color=%234477aa&cacheSeconds=900)](https://github.com/rse/speechflow)
[![github (project release)](https://img.shields.io/github/package-json/x-release/rse/speechflow?logo=github&label=project%20release&color=%234477aa&cacheSeconds=900)](https://github.com/rse/speechflow)

About
-----

**SpeechFlow** is a command-line interface based tool for macOS,
Windows and Linux, establishing a directed data flow graph of audio
and text processing nodes. This way, it allows to perform various
speech processing tasks in a very flexible and configurable way. The
usual supported tasks are capturing audio, generate narrations of
text (aka text-to-speech), generate transcriptions or subtitles for
audio (aka speech-to-text), and generate translations for audio (aka
speech-to-speech).

**SpeechFlow** comes with built-in graph nodes for various functionalities:

- file and audio device I/O for local connectivity,
- WebSocket and MQTT network I/O for remote connectivity,
- local Voice Activity Detection (VAD),
- local voice gender recognition,
- local audio LUFS-S/RMS metering,
- local audio Speex and RNNoise noise suppression,
- local audio compressor and expander dynamics processing,
- local audio gain adjustment,
- local audio gap filler processing,
- remote-controlable audio muting,
- cloud-based speech-to-text conversion with
  [Amazon Transcribe](https://aws.amazon.com/transcribe/),
  [OpenAI GPT-Transcribe](https://platform.openai.com/docs/models/gpt-4o-mini-transcribe), or 
  [Deepgram](https://deepgram.com).
- cloud-based text-to-text translation (or spelling correction) with 
  [DeepL](https://deepl.com),
  [Amazon Translate](https://aws.amazon.com/translate/),
  [Google Cloud Translate](https://cloud.google.com/translate), or
  [OpenAI GPT](https://openai.com).
- local text-to-text translation (or spelling correction) with
  [Ollama/Gemma](https://ollama.com) or
  [Transformers/OPUS](https://github.com/Helsinki-NLP/Opus-MT).
- cloud-based text-to-speech conversion with
  [ElevenLabs](https://elevenlabs.io/) or
  [Amazon Polly](https://aws.amazon.com/polly/).
- local text-to-speech conversion with [Kokoro](https://github.com/nazdridoy/kokoro-tts).
- local [FFmpeg](https://ffmpeg.org/)-based speech-to-speech conversion,
- local WAV speech-to-speech decoding/encoding,
- local text-to-text formatting, regex-based modification,
  sentencing merging/splitting,
  subtitle generation, and formatting.
- local text or audio chunk filtering and tracing.

Additional, **SpeechFlow** graph nodes can be provided externally
by NPM packages named `speechflow-node-xxx` which expose a class
derived from the exported `SpeechFlowNode` class of the `speechflow` package.

**SpeechFlow** is written in TypeScript and
ships as an installable package for the Node Package Manager (NPM).

Impression
----------

**SpeechFlow** is a command-line interface (CLI) based tool, so there
is no exciting screenshot possible from its CLI appearance, of course.
Instead, here is a sample of a fictive training which is held in German
and real-time translated to English.

First, the used configuration was a straight linear pipeline in file `sample.conf`:

```txt
xio-device(device: env.SPEECHFLOW_DEVICE_MIC, mode: "r") |
a2a-meter(interval: 50, dashboard: "meter1") |
a2t-deepgram(language: "de", model: "nova-2", interim: true) |
x2x-trace(type: "text", dashboard: "text1") |
x2x-filter(name: "final", type: "text", var: "kind", op: "==", val: "final") |
t2t-sentence() |
x2x-trace(type: "text", dashboard: "text2") |
t2t-deepl(src: "de", dst: "en") |
x2x-trace(type: "text", dashboard: "text3") |
t2a-elevenlabs(voice: "Mark", optimize: "latency", speed: 1.05, language: "en") |
a2a-meter(interval: 50, dashboard: "meter2") |
xio-device(device: env.SPEECHFLOW_DEVICE_SPK, mode: "w")
```

Second, the corresponding **SpeechFlow** command was:

```sh
$ speechflow -v info -c sample.conf \
  -d audio:meter1:DE,text:text1:DE-Interim,text:text2:DE-Final,text:text3:EN,audio:meter2:EN
```

Finally, the resulting dashboard under URL `http://127.0.0.1:8484/` was:

![dashboard](etc/speechflow.png)

On the left you can see the volume meter of the microphone (`xio-device`),
followed by the German result of the speech-to-text conversion
(`a2t-deepgram`), followed by the still German results of the text-to-text
sentence splitting/aggregation (`t2t-sentence`), followed by the English
results of the text-to-text translation (`t2t-deepl`) and then finally on
the right you can see the volume meter of the text-to-speech conversion
(`t2a-elevenlabs`).

The entire **SpeechFlow** processing pipeline runs in real-time and
the latency between input and output audio is about 2-3 seconds, very
similar to the usual latency human live translators also cause. The
latency primarily comes from the speech-to-text part in the pipeline,
as the end of sentences have to be awaited -- especially in the German
language where the verb can come very late in a sentence. So, the
latency is primarily not caused by any technical aspects, but by the
nature of live translation.

Installation
------------

```sh
$ npm install -g speechflow
```

Usage
-----

```txt
$ speechflow
  [-h|--help]
  [-V|--version]
  [-S|--status]
  [-v|--verbose <level>]
  [-a|--address <ip-address>]
  [-p|--port <tcp-port>]
  [-C|--cache <directory>]
  [-e|--expression <expression>]
  [-f|--file <file>]
  [-c|--config <id>@<yaml-config-file>]
  [<argument> [...]]
```

Graph Expression Language
-------------------------

The **SpeechFlow** graph expression language is based on
[**FlowLink**](https://npmjs.org/flowlink), which itself has a language
following the following BNF-style grammar:

```txt
#   (sub-)graph expression: set or sequence of nodes, single node, or group
expr             ::= parallel
                   | sequential
                   | node
                   | group

#   set of nodes, connected in parallel
parallel         ::= sequential ("," sequential)+

#   sequence of nodes, connected in chain
sequential       ::= node ("|" node)+

#   single node with optional parameter(s) and optional links
node             ::= id ("(" (param ("," param)*)? ")")? links?

#   single parameter: array, object, variable reference, template string,
#   or string/number literal, or special value literal
param            ::= array | object | variable | template | string | number | value

#   set of links
links            ::= link (_ link)*
link             ::= "<" | "<<" | ">" | ">>" id

#   group with sub-graph
group            ::= "{" expr "}"

#   identifier and variable
id               ::= /[a-zA-Z_][a-zA-Z0-9_-]*/
variable         ::= id

#   array of values
array            ::= "[" (param ("," param)*)? "]"

#   object of key/valus
object           ::= "{" (id ":" param ("," id ":" param)*)? "}"

#   template string
template         ::= "`" ("${" variable "}" / ("\\`"|.))* "`"

#   string literal
string           ::= /"(\\"|.)*"/
                   | /'(\\'|.)*'/

#   number literal
number           ::= /[+-]?/ number-value
number-value     ::= "0b" /[01]+/
                   | "0o" /[0-7]+/
                   | "0x" /[0-9a-fA-F]+/
                   | /[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?/
                   | /[0-9]+/

#   special value literal
value            ::= "true" | "false" | "null" | "NaN" | "undefined"
```

**SpeechFlow** makes available to **FlowLink** all **SpeechFlow** nodes as
`node`, the CLI arguments under the array `variable` named `argv`, and all
environment variables under the object `variable` named `env`.

Processing Graph Examples
-------------------------

The following are examples of particular **SpeechFlow** processing graphs.
They can also be found in the sample [speechflow.yaml](./etc/speechflow.yaml) file.

- **Capturing**: Capture audio from microphone device into WAV audio file:

  ```
  xio-device(device: env.SPEECHFLOW_DEVICE_MIC, mode: "r") |
      a2a-wav(mode: "encode") |
          xio-file(path: "capture.wav", mode: "w", type: "audio")
  ```

- **Pass-Through**: Pass-through audio from microphone device to speaker
  device and in parallel record it to WAV audio file:

  ```
  xio-device(device: env.SPEECHFLOW_DEVICE_MIC, mode: "r") | {
      a2a-wav(mode: "encode") |
          xio-file(path: "capture.wav", mode: "w", type: "audio"),
      xio-device(device: env.SPEECHFLOW_DEVICE_SPK, mode: "w")
  }
  ```

- **Transcription**: Generate text file with German transcription of MP3 audio file:

  ```
  xio-file(path: argv.0, mode: "r", type: "audio") |
      a2a-ffmpeg(src: "mp3", dst: "pcm") |
          a2t-deepgram(language: "de", key: env.SPEECHFLOW_DEEPGRAM_KEY) |
              t2t-format(width: 80) |
                  xio-file(path: argv.1, mode: "w", type: "text")
  ```

- **Subtitling**: Generate text file with German subtitles of MP3 audio file:

  ```
  xio-file(path: argv.0, mode: "r", type: "audio") |
      a2a-ffmpeg(src: "mp3", dst: "pcm") |
          a2t-deepgram(language: "de", key: env.SPEECHFLOW_DEEPGRAM_KEY) |
              t2t-subtitle(format: "vtt") |
                  xio-file(path: argv.1, mode: "w", type: "text")
  ```

- **Speaking**: Generate audio file with English voice for a text file:

  ```
  xio-file(path: argv.0, mode: "r", type: "text") |
      t2a-kokoro(language: "en") |
          a2a-wav(mode: "encode") |
              xio-file(path: argv.1, mode: "w", type: "audio")
  ```

- **Ad-Hoc Translation**: Ad-Hoc text translation from German to English
  via stdin/stdout:

  ```
  xio-file(path: "-", mode: "r", type: "text") |
      t2t-deepl(src: "de", dst: "en") |
          xio-file(path: "-", mode: "w", type: "text")
  ```

- **Studio Translation**: Real-time studio translation from German to English,
  including the capturing of all involved inputs and outputs:

  ```
  xio-device(device: env.SPEECHFLOW_DEVICE_MIC, mode: "r") | {
      a2a-gender() | {
          a2a-meter(interval: 250) |
              a2a-wav(mode: "encode") |
                  xio-file(path: "program-de.wav", mode: "w", type: "audio"),
          a2t-deepgram(language: "de", key: env.SPEECHFLOW_DEEPGRAM_KEY) | {
              t2t-sentence() | {
                  t2t-format(width: 80) |
                      xio-file(path: "program-de.txt", mode: "w", type: "text"),
                  t2t-deepl(src: "de", dst: "en", key: env.SPEECHFLOW_DEEPL_KEY) | {
                      x2x-trace(name: "text", type: "text") | {
                          t2t-format(width: 80) |
                              xio-file(path: "program-en.txt", mode: "w", type: "text"),
                          t2t-subtitle(format: "srt") |
                              xio-file(path: "program-en.srt", mode: "w", type: "text"),
                          xio-mqtt(url: "mqtt://10.1.0.10:1883",
                              username: env.SPEECHFLOW_MQTT_USER,
                              password: env.SPEECHFLOW_MQTT_PASS,
                              topicWrite: "stream/studio/sender"),
                          {
                              x2x-filter(name: "S2T-male", type: "text", var: "meta:gender", op: "==", val: "male") |
                                  t2a-elevenlabs(voice: "Mark", optimize: "latency", speed: 1.05, language: "en"),
                              x2x-filter(name: "S2T-female", type: "text", var: "meta:gender", op: "==", val: "female") |
                                  t2a-elevenlabs(voice: "Brittney", optimize: "latency", speed: 1.05, language: "en")
                          } | {
                              a2a-wav(mode: "encode") |
                                  xio-file(path: "program-en.wav", mode: "w", type: "audio"),
                              xio-device(device: env.SPEECHFLOW_DEVICE_SPK, mode: "w")
                          }
                      }
                  }
              }
          }
      }
  }
  ```

Processing Node Types
---------------------

First a short overview of the available processing nodes:

- Input/Output nodes:
  **xio-file**,
  **xio-device**,
  **xio-websocket**,
  **xio-mqtt**.
- Audio-to-Audio nodes:
  **a2a-ffmpeg**,
  **a2a-wav**,
  **a2a-mute**,
  **a2a-meter**,
  **a2a-vad**,
  **a2a-gender**,
  **a2a-speex**,
  **a2a-rnnoise**,
  **a2a-compressor**,
  **a2a-expander**,
  **a2a-gain**,
  **a2a-filler**.
- Audio-to-Text nodes:
  **a2t-openai**,
  **a2t-amazon**,
  **a2t-deepgram**.
- Text-to-Text nodes:
  **t2t-deepl**,
  **t2t-amazon**,
  **t2t-openai**,
  **t2t-ollama**,
  **t2t-transformers**,
  **t2t-google**,
  **t2t-modify**,
  **t2t-subtitle**,
  **t2t-format**,
  **t2t-sentence**.
- Text-to-Audio nodes:
  **t2a-amazon**,
  **t2a-elevenlabs**,
  **t2a-kokoro**.
- Any-to-Any nodes:
  **x2x-filter**,
  **x2x-trace**.

### Input/Output Nodes

The following nodes are for external I/O, i.e, to read/write from
external files, devices and network services.

- Node:    **xio-file**<br/>
  Purpose: **File and StdIO source/sink**<br/>
  Example: `xio-file(path: "capture.pcm", mode: "w", type: "audio")`

  > This node allows the reading/writing from/to files or from StdIO. It
  > is intended to be used as source and sink nodes in batch processing,
  > and as sing nodes in real-time processing.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter  | Position  | Default  | Requirement           |
  | ---------- | --------- | -------- | --------------------- |
  | **path**   | 0         | *none*   | *none*                |
  | **mode**   | 1         | "r"      | `/^(?:r\|w\|rw)$/`    |
  | **type**   | 2         | "audio"  | `/^(?:audio\|text)$/` |
  | **chunka** |           | 200      | `10 <= n <= 1000`     |
  | **chunkt** |           | 65536    | `1024 <= n <= 131072` |

- Node: **xio-device**<br/>
  Purpose: **Microphone/speaker device source/sink**<br/>
  Example: `xio-device(device: env.SPEECHFLOW_DEVICE_MIC, mode: "r")`

  > This node allows the reading/writing from/to audio devices. It is
  > intended to be used as source nodes for microphone devices and as
  > sink nodes for speaker devices.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement        |
  | ----------- | --------- | -------- | ------------------ |
  | **device**  | 0         | *none*   | `/^(.+?):(.+)$/`   |
  | **mode**    | 1         | "rw"     | `/^(?:r\|w\|rw)$/` |
  | **chunk**   | 2         | 200      | `10 <= n <= 1000`  |

- Node: **xio-websocket**<br/>
  Purpose: **WebSocket source/sink**<br/>
  Example: `xio-websocket(connect: "ws://127.0.0.1:12345", type: "text")`
  Notice: this node requires a peer WebSocket service!

  > This node allows reading/writing from/to WebSocket network services.
  > It is primarily intended to be used for sending out the text of
  > subtitles, but can be also used for receiving the text to be
  > processed.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter   | Position  | Default  | Requirement           |
  | ----------- | --------- | -------- | --------------------- |
  | **listen**  | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+))$/` |
  | **connect** | *none*    | *none*   | `/^(?:\|ws:\/\/(.+?):(\d+)(?:\/.*)?)$/` |
  | **type**    | *none*    | "audio"  | `/^(?:audio\|text)$/` |

- Node: **xio-mqtt**<br/>
  Purpose: **MQTT sink**<br/>
  Example: `xio-mqtt(url: "mqtt://127.0.0.1:1883", username: "foo", password: "bar", topic: "quux")`
  Notice: this node requires a peer MQTT broker!

  > This node allows reading/writing from/to MQTT broker topics. It is
  > primarily intended to be used for sending out the text of subtitles,
  > but can be also used for receiving the text to be processed.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | none        |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **url**      | 0         | *none*   | `/^(?:\|(?:ws\|mqtt):\/\/(.+?):(\d+))$/` |
  | **username** | 1         | *none*   | `/^.+$/` |
  | **password** | 2         | *none*   | `/^.+$/` |
  | **topic**    | 3         | *none*   | `/^.+$/` |

### Audio-to-Audio Nodes

The following nodes process audio chunks only.

- Node: **a2a-ffmpeg**<br/>
  Purpose: **FFmpeg audio format conversion**<br/>
  Example: `a2a-ffmpeg(src: "pcm", dst: "mp3")`

  > This node allows converting between audio formats. It is primarily
  > intended to support the reading/writing of external MP3 and Opus
  > format files, although SpeechFlow internally uses PCM format only.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement        |
  | ----------- | --------- | -------- | ------------------ |
  | **src**     | 0         | "pcm"    | `/^(?:pcm\|wav\|mp3\|opus)$/` |
  | **dst**     | 1         | "wav"    | `/^(?:pcm\|wav\|mp3\|opus)$/` |

- Node: **a2a-wav**<br/>
  Purpose: **WAV audio format conversion**<br/>
  Example: `a2a-wav(mode: "encode")`

  > This node allows converting between PCM and WAV audio formats. It is
  > primarily intended to support the reading/writing of external WAV
  > format files, although SpeechFlow internally uses PCM format only.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **mode**    | 0         | "encode" | `/^(?:encode\|decode)$/` |

- Node: **a2a-mute**<br/>
  Purpose: **volume muting node**<br/>
  Example: `a2a-mute()`
  Notice: this node has to be externally controlled via REST/WebSockets!

  > This node allows muting the audio stream by either silencing or even
  > unplugging. It has to be externally controlled via REST/WebSocket (see below).

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |

- Node: **a2a-meter**<br/>
  Purpose: **Loudness metering node**<br/>
  Example: `a2a-meter(250)`

  > This node allows measuring the loudness of the audio stream. The
  > results are emitted to both the logfile of **SpeechFlow** and the
  > WebSockets API (see below). It can optionally send the meter
  > information to the dashboard.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter     | Position  | Default  | Requirement            |
  | ------------- | --------- | -------- | ---------------------- |
  | **interval**  | 0         | 250      | *none*                 |
  | **mode**      | 1         | "filter" | `/^(?:filter\|sink)$/` |
  | **dashboard** |           | *none*   | *none*                 |

- Node: **a2a-vad**<br/>
  Purpose: **Voice Audio Detection (VAD) node**<br/>
  Example: `a2a-vad()`

  > This node perform Voice Audio Detection (VAD), i.e., it detects
  > voice in the audio stream and if not detected either silences or
  > unplugs the audio stream.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **mode**               | *none* | "unplugged" | `/^(?:silenced\|unplugged)$/` |
  | **posSpeechThreshold** | *none* | 0.50  | *none* |
  | **negSpeechThreshold** | *none* | 0.35  | *none* |
  | **minSpeechFrames**    | *none* | 2     | *none* |
  | **redemptionFrames**   | *none* | 12    | *none* |
  | **preSpeechPadFrames** | *none* | 1     | *none* |
  | **postSpeechTail**     | *none* | 1500  | *none* |

- Node: **a2a-gender**<br/>
  Purpose: **Gender Detection node**<br/>
  Example: `a2a-gender()`

  > This node performs gender detection on the audio stream. It
  > annotates the audio chunks with `gender=male` or `gender=female`
  > meta information. Use this meta information with the "filter" node.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter      | Position  | Default  | Requirement              |
  | -------------- | --------- | -------- | ------------------------ |
  | **window**     | 0         | 500      | *none*                   |
  | **treshold**   | 1         | 0.50     | *none*                   |
  | **hysteresis** | 2         | 0.25     | *none*                   |

- Node: **a2a-speex**<br/>
  Purpose: **Speex Noise Suppression node**<br/>
  Example: `a2a-speex(attentuate: -18)`

  > This node uses the Speex DSP pre-processor to perform noise
  > suppression, i.e., it detects and attenuates (by a certain level of
  > dB) the noise in the audio stream.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **attentuate** | 0 | -18  | *none* | `-60 <= n <= 0` |

- Node: **a2a-rnnoise**<br/>
  Purpose: **RNNoise Noise Suppression node**<br/>
  Example: `a2a-rnnoise()`

  > This node uses RNNoise to perform noise suppression, i.e., it
  > detects and attenuates the noise in the audio stream.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |

- Node: **a2a-compressor**<br/>
  Purpose: **audio compressor node**<br/>
  Example: `a2a-compressor(thresholdDb: -18)`

  > This node applies a dynamics compressor, i.e., it attenuates the
  > volume by a certain ratio whenever the volume is above the threshold.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **thresholdDb** | *none* | -18 | `n <= 0 && n >= -60` |
  | **ratio**       | *none* | 4   | `n >= 1 && n <= 20`  |
  | **attackMs**    | *none* | 10  | `n >= 0 && n <= 100` |
  | **releaseMs**   | *none* | 50  | `n >= 0 && n <= 100` |
  | **kneeDb**      | *none* | 6   | `n >= 0 && n <= 100` |
  | **makeupDb**    | *none* | 0   | `n >= 0 && n <= 100` |

- Node: **a2a-expander**<br/>
  Purpose: **audio expander node**<br/>
  Example: `a2a-expander(thresholdDb: -46)`

  > This node applies a dynamics expander, i.e., it attenuates the
  > volume by a certain ratio whenever the volume is below the threshold.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **thresholdDb** | *none* | -45 | `n <= 0 && n >= -60` |
  | **ratio**       | *none* | 4   | `n >= 1 && n <= 20`  |
  | **attackMs**    | *none* | 10  | `n >= 0 && n <= 100` |
  | **releaseMs**   | *none* | 50  | `n >= 0 && n <= 100` |
  | **kneeDb**      | *none* | 6   | `n >= 0 && n <= 100` |
  | **makeupDb**    | *none* | 0   | `n >= 0 && n <= 100` |

- Node: **a2a-gain**<br/>
  Purpose: **audio gain adjustment node**<br/>
  Example: `a2a-gain(db: 12)`

  > This node applies a gain adjustment to audio, i.e., it increases or
  > decreases the volume by certain decibels

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |
  | **db** | *none* | 12 | `n >= -60 && n <= -60` |

- Node: **a2a-filler**<br/>
  Purpose: **audio filler node**<br/>
  Example: `a2a-filler()`

  > This node adds missing audio frames of silence in order to fill
  > the chronological gaps between generated audio frames (from
  > text-to-speech).

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | audio       |

  | Parameter   | Position  | Default  | Requirement              |
  | ----------- | --------- | -------- | ------------------------ |

### Audio-to-Text Nodes

The following nodes convert audio to text chunks.

- Node: **a2t-openai**<br/>
  Purpose: **OpenAI/GPT Speech-to-Text conversion**<br/>
  Example: `a2t-openai(language: "de")`<br/>
  Notice: this node requires an OpenAI API key!

  > This node uses OpenAI GPT to perform Speech-to-Text (S2T)
  > conversion, i.e., it recognizes speech in the input audio stream and
  > outputs a corresponding text stream.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_OPENAI\_KEY | *none* |
  | **api**      | *none*    | "https://api.openai.com" | `/^https?:\/\/.+?:\d+$/` |
  | **model**    | *none*    | "gpt-4o-mini-transcribe" | *none* |
  | **language** | *none*    | "en"     | `/^(?:de\|en)$/` |
  | **interim**  | *none*    | false    | *none* |

- Node: **a2t-amazon**<br/>
  Purpose: **Amazon Transcribe Speech-to-Text conversion**<br/>
  Example: `a2t-amazon(language: "de")`<br/>
  Notice: this node requires an API key!

  > This node uses Amazon Trancribe to perform Speech-to-Text (S2T)
  > conversion, i.e., it recognizes speech in the input audio stream and
  > outputs a corresponding text stream.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | audio       |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_AMAZON\_KEY | *none* |
  | **secKey**   | *none*    | env.SPEECHFLOW\_AMAZON\_KEY\_SEC | *none* |
  | **region**   | *none*    | "eu-central-1" | *none* |
  | **language** | *none*    | "en" | `/^(?:en|de)$/` |
  | **interim**  | *none*    | false | *none* |

- Node: **a2t-deepgram**<br/>
  Purpose: **Deepgram Speech-to-Text conversion**<br/>
  Example: `a2t-deepgram(language: "de")`<br/>
  Notice: this node requires an API key!

  > This node performs Speech-to-Text (S2T) conversion, i.e., it
  > recognizes speech in the input audio stream and outputs a
  > corresponding text stream.

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

### Text-to-Text Nodes

The following nodes process text chunks only.

- Node: **t2t-deepl**<br/>
  Purpose: **DeepL Text-to-Text translation**<br/>
  Example: `t2t-deepl(src: "de", dst: "en")`<br/>
  Notice: this node requires an API key!

  > This node performs translation between English and German languages.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_DEEPL\_KEY | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **t2t-amazon**<br/>
  Purpose: **AWS Translate Text-to-Text translation**<br/>
  Example: `t2t-amazon(src: "de", dst: "en")`<br/>
  Notice: this node requires an API key!

  > This node performs translation between English and German languages.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_AMAZON\_KEY | *none* |
  | **secKey**   | *none*    | env.SPEECHFLOW\_AMAZON\_KEY\_SEC | *none* |
  | **region**   | *none*    | "eu-central-1" | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **t2t-openai**<br/>
  Purpose: **OpenAI/GPT Text-to-Text translation and spelling correction**<br/>
  Example: `t2t-openai(src: "de", dst: "en")`<br/>
  Notice: this node requires an OpenAI API key!

  > This node performs translation between English and German languages
  > in the text stream or (if the source and destination language is
  > the same) spellchecking of English or German languages in the text
  > stream. It is based on the remote OpenAI cloud AI service and uses
  > the GPT-4o-mini LLM.

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
  | **model**    | *none*    | "gpt-5-mini" | *none* |

- Node: **t2t-ollama**<br/>
  Purpose: **Ollama/Gemma Text-to-Text translation and spelling correction**<br/>
  Example: `t2t-ollama(src: "de", dst: "en")`<br/>
  Notice: this node requires Ollama to be installed!

  > This node performs translation between English and German languages
  > in the text stream or (if the source and destination language is
  > the same) spellchecking of English or German languages in the text
  > stream. It is based on the local Ollama AI service and uses the
  > Google Gemma 3 LLM.

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

- Node: **t2t-transformers**<br/>
  Purpose: **Transformers Text-to-Text translation**<br/>
  Example: `t2t-transformers(src: "de", dst: "en")`<br/>

  > This node performs translation between English and German languages
  > in the text stream. It is based on local OPUS or SmolLM3 LLMs.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement      |
  | ------------ | --------- | -------- | ---------------- |
  | **model**    | *none*    | "OPUS"   | `/^(?:OPUS\|SmolLM3)$/` |
  | **src**      | 0         | "de"     | `/^(?:de\|en)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en)$/` |

- Node: **t2t-google**<br/>
  Purpose: **Google Cloud Translate Text-to-Text translation**<br/>
  Example: `t2t-google(src: "de", dst: "en")`<br/>
  Notice: this node requires a Google Cloud API key and project ID!

  > This node performs translation between multiple languages
  > in the text stream using Google Cloud Translate API.
  > It supports German, English, French, and Italian languages.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **key**      | *none*    | env.SPEECHFLOW\_GOOGLE\_KEY | *none* |
  | **src**      | 0         | "de"     | `/^(?:de\|en\|fr\|it)$/` |
  | **dst**      | 1         | "en"     | `/^(?:de\|en\|fr\|it)$/` |

- Node: **t2t-modify**<br/>
  Purpose: **regex-based text modification**<br/>
  Example: `t2t-modify(match: "\\b(hello)\\b", replace: "hi $1")`<br/>

  > This node allows regex-based modification of text chunks using pattern
  > matching and replacement with support for $n backreferences. It is
  > primarily intended for text preprocessing, cleanup, or transformation tasks.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **match**    | 0         | ""       | *required*         |
  | **replace**  | 1         | ""       | *required*         |

- Node: **t2t-sentence**<br/>
  Purpose: **sentence splitting/merging**<br/>
  Example: `t2t-sentence()`<br/>

  > This node allows you to ensure that a text stream is split or merged
  > into complete sentences. It is primarily intended to be used after
  > the "a2t-deepgram" node and before "t2t-deepl" or "t2a-elevenlabs" nodes in
  > order to improve overall quality.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |

- Node: **t2t-subtitle**<br/>
  Purpose: **SRT/VTT Subtitle Generation**<br/>
  Example: `t2t-subtitle(format: "srt")`<br/>

  > This node generates subtitles from the text stream (and its embedded
  > timestamps) in the formats SRT (SubRip) or VTT (WebVTT).

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement        |
  | ------------ | --------- | -------- | ------------------ |
  | **format**   | *none*    | "srt"    | /^(?:srt\|vtt)$/   |
  | **words**    | *none*    | false    | *none*             |

- Node: **t2t-format**<br/>
  Purpose: **text paragraph formatting**<br/>
  Example: `t2t-format(width: 80)`<br/>

  > This node formats the text stream into lines no longer than a
  > certain width. It is primarily intended for use before writing text
  > chunks to files.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | text        |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **width**    | 0         | 80       | *none*                |

### Text-to-Audio Nodes

The following nodes convert text chunks to audio chunks.

- Node: **t2a-amazon**<br/>
  Purpose: **Amazon Polly Text-to-Speech conversion**<br/>
  Example: `t2a-amazon(language: "en", voice: "Danielle)`<br/>
  Notice: this node requires an Amazon API key!

  > This node uses Amazon Polly to perform Text-to-Speech (T2S)
  > conversion, i.e., it converts the input text stream into an output
  > audio stream. It is intended to generate speech.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | audio       |

  | Parameter      | Position  | Default   | Requirement        |
  | -------------- | --------- | --------- | ------------------ |
  | **key**        | *none*    | env.SPEECHFLOW\_AMAZON\_KEY | *none* |
  | **secKey**     | *none*    | env.SPEECHFLOW\_AMAZON\_KEY\_SEC | *none* |
  | **region**     | *none*    | "eu-central-1" | *none* |
  | **voice**      | 0         | "Amy"     | `^(?:Amy|Danielle|Joanna|Matthew|Ruth|Stephen|Viki|Daniel)$/` |
  | **language**   | 1         | "en"      | `/^(?:de\|en)$/`  |

- Node: **t2a-elevenlabs**<br/>
  Purpose: **ElevenLabs Text-to-Speech conversion**<br/>
  Example: `t2a-elevenlabs(language: "en")`<br/>
  Notice: this node requires an ElevenLabs API key!

  > This node uses ElevenLabs to perform Text-to-Speech (T2S)
  > conversion, i.e., it converts the input text stream into an output
  > audio stream. It is intended to generate speech.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | audio       |

  | Parameter      | Position  | Default   | Requirement        |
  | -------------- | --------- | --------- | ------------------ |
  | **key**        | *none*    | env.SPEECHFLOW\_ELEVENLABS\_KEY | *none* |
  | **voice**      | 0         | "Brian"   | `/^(?:Brittney\|Cassidy\|Leonie\|Mark\|Brian)$/` |
  | **language**   | 1         | "de"      | `/^(?:de\|en)$/`  |
  | **speed**      | 2         | 1.00      | `n >= 0`7 && n <= 1.2` |
  | **stability**  | 3         | 0.5       | `n >= 0.0 && n <= 1.0` |
  | **similarity** | 4         | 0.75      | `n >= 0.0 && n <= 1.0` |
  | **optimize**   | 5         | "latency" | `/^(?:latency\|quality)$/` |

- Node: **t2a-kokoro**<br/>
  Purpose: **Kokoro Text-to-Speech conversion**<br/>
  Example: `t2a-kokoro(language: "en")`<br/>
  Notice: this currently support English language only!

  > This node uses Kokoro to perform Text-to-Speech (T2S) conversion,
  > i.e., it converts the input text stream into an output audio stream.
  > It is intended to generate speech.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text        |
  | output  | audio       |

  | Parameter    | Position  | Default  | Requirement |
  | ------------ | --------- | -------- | ----------- |
  | **voice**    | 0         | "Aoede"  | `/^(?:Aoede\|Heart\|Puck\|Fenrir)$/` |
  | **language** | 1         | "en"     | `/^en$/`    |
  | **speed**    | 2         | 1.25     | 1.0...1.30  |

### Any-to-Any Nodes

The following nodes process any type of chunk, i.e., both audio and text chunks.

- Node: **x2x-filter**<br/>
  Purpose: **meta information based filter**<br/>
  Example: `x2x-filter(type: "audio", var: "meta:gender", op: "==", val: "male")`<br/>

  > This node allows you to filter nodes based on certain criteria. It
  > is primarily intended to be used in conjunction with the "a2a-gender"
  > node and in front of the `elevenlabs` or `kokoro` nodes in order to
  > translate with a corresponding voice.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter    | Position  | Default  | Requirement           |
  | ------------ | --------- | -------- | --------------------- |
  | **type**     | 0         | "audio"  | `/^(?:audio\|text)$/` |
  | **name**     | 1         | "filter" | `/^.+$/` |
  | **var**      | 2         | ""       | `/^(?:meta:.+\|payload:(?:length\|text)\|time:(?:start\|end))$/` |
  | **op**       | 3         | "=="     | `/^(?:<\|<=\|==\|!=\|~~\|!~\|>=\|>)$/` |
  | **val**      | 4         | ""       | `/^.*$/` |

- Node: **x2x-trace**<br/>
  Purpose: **data flow tracing**<br/>
  Example: `x2x-trace(type: "audio")`<br/>

  > This node allows you to trace the audio and text chunk flow through
  > the **SpeechFlow** graph. It just passes through its chunks (in
  > mode "filter") or acts as a sink for the chunks (in mode "sink"),
  > but always sends information about the chunks to the log. For type
  > "text", the information can be also send to the dashboard.

  | Port    | Payload     |
  | ------- | ----------- |
  | input   | text, audio |
  | output  | text, audio |

  | Parameter     | Position  | Default  | Requirement            |
  | ------------- | --------- | -------- | ---------------------- |
  | **type**      | 0         | "audio"  | `/^(?:audio\|text)$/`  |
  | **name**      | 1         | "trace"  | *none*                 |
  | **mode**      | 2         | "filter" | `/^(?:filter\|sink)$/` |
  | **dashboard** |           | *none*   | *none*                 |

REST/WebSocket API
------------------

**SpeechFlow** has an externally exposed REST/WebSockets API which can
be used to control the nodes and to receive information from nodes.
For controlling a node you have three possibilities (illustrated by
controlling the mode of the "a2a-mute" node):

```sh
# use HTTP/REST/GET:
$ curl http://127.0.0.1:8484/api/COMMAND/a2a-mute/mode/silenced
```

```sh
# use HTTP/REST/POST:
$ curl -H "Content-type: application/json" \
  --data '{ "request": "COMMAND", "node": "a2a-mute", "args": [ "mode", "silenced" ] }' \
  http://127.0.0.1:8484/api
```

```sh
# use WebSockets:
$ wscat -c ws://127.0.0.1:8484/api \
> { "request": "COMMAND", "node": "a2a-mute", "args": [ "mode", "silenced" ] }
```

For receiving emitted information from nodes, you have to use the WebSockets
API (illustrated by the emitted information of the "a2a-meter" node):

```sh
# use WebSockets:
$ wscat -c ws://127.0.0.1:8484/api \
< { "response": "NOTIFY", "node": "a2a-meter", "args": [ "meter", "LUFS-S", -35.75127410888672 ] }
```

History
-------

**SpeechFlow**, as a technical cut-through, was initially created in
March 2024 for use in the msg Filmstudio context. It was later refined
into a more complete toolkit in April 2025 and this way the first time
could be used in production. It was fully refactored in July 2025 in
order to support timestamps in the streams processing.

Copyright & License
-------------------

Copyright &copy; 2024-2025 [Dr. Ralf S. Engelschall](mailto:rse@engelschall.com)<br/>
Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)

