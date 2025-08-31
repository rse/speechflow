
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

## Project Overview

SpeechFlow is a command-line interface tool for establishing directed
data flow graphs of audio and text processing nodes. It enables flexible
speech processing tasks including capturing audio, text-to-speech,
speech-to-text, and speech-to-speech translation.

## Architecture

SpeechFlow uses a modular node-based architecture:

- **Core Engine**: TypeScript-based CLI tool that orchestrates processing flows
- **Processing Nodes**: Modular components for different speech processing tasks (see `src/speechflow-node-*.ts`)
- **Flow Expression Language**: Based on FlowLink for defining processing graphs
- **Web Interfaces**: Two Vue.js applications for dashboard and subtitle display
- **REST/WebSocket API**: External control interface for nodes

### Key Components

- **Main CLI**:
  `src/speechflow.ts` - Entry point and CLI parsing
- **Nodes**:
  - Input/Output: `file`, `device`, `websocket`, `mqtt`  
  - Audio-to-Audio: `ffmpeg`, `wav`, `mute`, `meter`, `vad`, `gender`
  - Audio-to-Text: `deepgram`
  - Text-to-Text: `deepl`, `openai`, `ollama`, `transformers`, `subtitle`, `format`, `sentence`
  - Text-to-Audio: `elevenlabs`, `kokoro`
  - Any-to-Any: `filter`, `trace`

## Development Commands

The project uses STX (Simple Task eXecutor) for build automation. Main commands:

### Core Project

```bash
npm start lint          # Static code analysis (TypeScript, ESLint, Biome, Oxlint)
npm start build         # Compile TypeScript to JavaScript in dst/
npm start dev           # Multi-pane development dashboard with linting, building, and server
npm start server        # Run the main speechflow program
npm start clean         # Remove generated files
```

## Project Structure

- `src/` - Main TypeScript source files
- `dst/` - Compiled JavaScript output
- `etc/` - Configuration files (TypeScript, ESLint, Biome, etc.)
- `package.d/` - NPM package patches

## Development Notes

- Node.js 22+ required
- Uses object-mode streaming with timestamps for audio/text processing
- External services integration: Deepgram, ElevenLabs, DeepL, OpenAI, Ollama
- Supports local processing: FFmpeg, WAV, Voice Activity Detection, Gender Detection
- REST/WebSocket API on port 8484 for external control

## Configuration

Main configuration in `etc/speechflow.yaml` with example
processing graphs. Environment variables used for API keys (e.g.,
`SPEECHFLOW_DEEPGRAM_KEY`, `SPEECHFLOW_ELEVENLABS_KEY`).

