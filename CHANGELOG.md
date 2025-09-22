
ChangeLog
=========

1.6.6 (2025-09-21)
------------------

- BUGFIX: fix meta handling in a2t-deepgram, a2t-amazon and a2t-openai nodes to not destroy a2a-gender information
- BUGFIX: do not loose meta information in chunk processing
- CLEANUP: align destruction handling in a2a-gender node with other nodes
- CLEANUP: use consistent Error object handling in throwing exceptions
- CLEANUP: consistently use stream destruction procedure

1.6.5 (2025-09-21)
------------------

- IMPROVEMENT: in a2a-gender node, classify an audio chunk as "unknown" if volume is too low
- IMPROVEMENT: switch a2a-meter node fom 3s LUFS-S to 0.4s LUFS-M measurement to be faster
- IMPROVEMENT: improve buffer handling within a2a-meter node
- BUGFIX: allow xio-device node to correctly produce audio chunks of arbitrary size
- BUGFIX: correctly construct the API URLs for WebSocket connections in UIs
- UPDATE: upgrade NPM dependencies

1.6.4 (2025-09-14)
------------------

- IMPROVEMENT: allow a2a-meter node to be a sink to simplify configurations
- IMPROVEMENT: allow x2x-trace node to be a sink to simplify configurations
- IMPROVEMENT: improve rendering of the subtitle Web UI
- BUGFIX: in the subtitle Web UI remove texts after time automatically
- BUGFIX: clear the meters in the dashboard on connection close
- UPDATE: upgrade NPM dependencies

1.6.3 (2025-09-08)
------------------

- BUGFIX: workaround problems on "device" node close caused by PortAudio's internals
- CLEANUP: cleanup code

1.6.2 (2025-09-07)
------------------

- CLEANUP: cleanup code

1.6.1 (2025-09-06)
------------------

- CLEANUP: cleanup code
- REFACTOR: splitted large utils code
- REFACTOR: splitted large main code

1.6.0 (2025-09-06)
------------------

- REFACTORING: all nodes now have a prefix
- IMPROVEMENT: add "t2t-modify" node for text replacements
- BUGFIX: fix writing to stdout where the program was hanging
- UPDATE: upgrade NPM dependencies

1.5.1 (2025-09-02)
------------------

- IMPROVEMENT: add Google Translate node
- BUGFIX: improve error handling by ensuring we have always an Error object at hand
- UPDATE: upgrade NPM dependencies

1.5.0 (2025-08-31)
------------------

- IMPROVEMENT: add improved dashboard infrastructure and allow nodes to publish dashboard info
- IMPROVEMENT: add CLI option for exporting dashboard info via OSC
- IMPROVEMENT: add new audio processing nodes (compressor with sidechain, expander, gain, filler)
- IMPROVEMENT: add AWS integration nodes (Polly, Translate, Transcribe)
- IMPROVEMENT: add OpenAI Transcribe node for speech-to-text
- IMPROVEMENT: add noise suppression nodes (rnnoise, speex)
- IMPROVEMENT: provide audio helper utilities and access bus functionality
- IMPROVEMENT: improve types and error handling
- IMPROVEMENT: switch to GPT-5 with improved error handling and timeout support
- IMPROVEMENT: switch from native compressor to custom implementation
- BUGFIX: fix usage of AudioIO quit and abort methods
- BUGFIX: fix operator order in audio processing
- BUGFIX: reset envelope array when channels change
- BUGFIX: fix parameter configuration in audio nodes
- BUGFIX: fix private field access and remove unnecessary casts
- UPDATE: upgrade NPM dependencies
- UPDATE: update OxLint rules and configuration
- CLEANUP: cleanup and simplify code throughout project
- CLEANUP: cleanup expander node implementation and remove stereoLink feature
- CLEANUP: cleanup gender, ffmpeg, filler, and AWS nodes
- CLEANUP: reduce code depth in multiple components
- CLEANUP: align identifiers with remaining code
- CLEANUP: make code compliant with updated linter rules
- CLEANUP: fix indentation and remove duplicate entries

1.4.5 (2025-08-07)
------------------

- IMPROVEMENT: better CLI option handling
- IMPROVEMENT: better optical appearance of dashboard
- BUGFIX: do not complain if no .env file is found
- BUGFIX: avoid read-timeouts in "deepgram" node
- CLEANUP: output stack traces only for "info" and "debug" verbosity levels

1.4.4 (2025-08-07)
------------------

- BUGFIX: do not ignore "dst" files in NPM distribution
- UPGRADE: upgrade NPM dependencies

1.4.3 (2025-08-06)
------------------

- IMPROVEMENT: better fatal error handling in main program
- IMPROVEMENT: better optical appearance of dashboard
- IMPROVEMENT: better reporting of STX build CWD
- UPGRADE: upgrade NPM dependencies

1.4.2 (2025-08-05)
------------------

- CLEANUP: various code cleanups

1.4.1 (2025-08-05)
------------------

- CLEANUP: fix logo references
- BUGFIX: fix top-level exports after refactoring

1.4.0 (2025-08-05)
------------------

- IMPROVEMENT: add dashboard infrastructure and expose information from "meter" and "trace" nodes
- IMPROVEMENT: add subtitle web interface for real-time subtitle display
- IMPROVEMENT: allow "deepgram" node to optionally provide "interim" results (primarily for subtitle)
- IMPROVEMENT: allow "filter" node to filter on chunk kind and type
- IMPROVEMENT: disable endpointing in "deepgram" node as it makes no sense for us
- IMPROVEMENT: allow -d (dashboard) option to accept a name which is displayed below the dashboard columns
- IMPROVEMENT: display names below the dashboard columns in UI
- IMPROVEMENT: move text columns in dashboard UI always to the bottom of the screen
- IMPROVEMENT: in dashboard UI adjust all colors to be blue as the main theme and make font sizes more eligible
- BUGFIX: switch back "deepgram" node to use "nova-2" model (as it supports numerals feature, etc)
- CLEANUP: in "deepgram" node remove ancient initialization workaround
- CLEANUP: simplify codebase structure and remove redundancy
- UPGRADE: upgrade NPM dependencies

1.3.2 (2025-08-04)
------------------

- BUGFIX: many timeout handling fixes in many nodes
- CLEANUP: many code cleanups

1.3.1 (2025-07-31)
------------------

- BUGFIX: wait a longer time for "deepgram" node to open
- IMPROVEMENT: keep word information as meta information in "deepgram" node
- IMPROVEMENT: support words in subtitle generation in "subtitle" node
- BUGFIX: fix WebVTT format generation in "subtitle" node
- UPGRADE: upgrade NPM dependencies

1.3.0 (2025-07-26)
------------------

- IMPROVEMENT: add new "sentence" node for sentence splitting/merging
- BUGFIX: more robust shutdown in main program
- BUGFIX: more robust shutdown in "gender" node
- CLEANUP: log less under "info" log level
- UPGRADE: upgrade NPM dependencies

1.2.8 (2025-07-22)
------------------

- BUGFIX: fix "shebang" line generation

1.2.7 (2025-07-22)
------------------

- UPGRADE: upgrade NPM dependencies (to fix "stx" under Windows once again)

1.2.6 (2025-07-21)
------------------

- UPGRADE: upgrade NPM dependencies (to fix "stx" under Windows)

1.2.5 (2025-07-21)
------------------

- UPGRADE: upgrade NPM dependencies

1.2.4 (2025-07-21)
------------------

- CLEANUP: improve logging outputs

1.2.3 (2025-07-21)
------------------

- UPGRADE: upgrade NPM dependencies
- BUGFIX: set highwatermark to 1 for all object-mode streams
- BUGFIX: fix comparison in filter node
- CLEANUP: remove unused NPM dependencies
- CLEANUP: update studio-translation config

1.2.2 (2025-07-21)
------------------

- CLEANUP: cleanup usage information
- UPGRADE: upgrade NPM dependencies

1.2.1 (2025-07-21)
------------------

- CLEANUP: cleanup usage information
- IMPROVEMENT: add optional "build-pkg" build target for creating an all-in-one-package

1.2.1 (2025-07-21)
------------------

- CLEANUP: refactor main cleanup procedure
- CLEANUP: consistenly use "<xxx>" for nodes in outputs
- UPGRADE: upgrade NPM dependencies

1.2.0 (2025-07-21)
------------------

- IMPROVEMENT: rewrite "wav" node to be self-contained and preserve chunk information (time, meta)
- IMPROVEMENT: the "trace" node now also outputs meta information
- IMPROVEMENT: add "gender" node for male/female speaker detection (result is passed as meta information)
- IMPROVEMENT: add "filter" node for filtering based on meta information
- IMPROVEMENT: do not segment audio stream chunks for "vad" node even if it internally has to segment it
- IMPROVEMENT: allow chunking duration/size to be controlled for device/file nodes
- UPGRADE: upgrade NPM dependencies

1.1.0 (2025-07-19)
------------------

- IMPROVEMENT: allow querying the status of nodes: currently used for gathering credit/usage information
- BUGFIX: add "final" callback to Stream.Transform of "meter" node
- BUGFIX: fix positional argument usage in "meter" node
- UPGRADE: upgrade NPM dependencies

1.0.0 (2025-07-16)
------------------

- IMPROVEMENT: add "vad" node for voice audio detection
- IMPROVEMENT: add "mute" node for audio muting
- IMPROVEMENT: add "meter" node for audio loudness metering
- IMPROVEMENT: add REST/WebSocket API for external requests to nodes and events from nodes

0.9.9 (2025-07-13)
------------------

- IMPROVEMENT: add "openai" node for text-to-text translation and spellchecking
- IMPROVEMENT: add "kokoro" node for local text-to-speech generation
- CLEANUP: switch "trace" node to output log messages with "debug" level
- CLEANUP: cleanup CLI option parsing
- UPGRADE: upgrade NPM dependencies

0.9.8 (2025-07-12)
------------------

- CLEANUP: provide start scripts and move config to sub-directory

0.9.7 (2025-07-12)
------------------

- IMPROVEMENT: replace "nps" with "stx" for NPM scripting

0.9.6 (2025-07-12)
------------------

- IMPROVEMENT: major refactoring to object-mode streaming for supporting timestamps
- UPGRADE: upgrade NPM dependencies

0.9.5 (2025-04-27)
------------------

(first rough cut of program)

