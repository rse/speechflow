
ChangeLog
=========

1.1.1 (2025-07-19)
------------------

- IMPROVEMENT: rewrite "wav" node to be self-contained and preserve chunk information (time, meta)
- IMPROVEMENT: the "trace" node now also outputs meta information
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

