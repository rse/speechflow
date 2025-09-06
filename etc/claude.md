# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SpeechFlow is a command-line interface tool for establishing directed data flow graphs of audio and text processing nodes. It enables flexible speech processing tasks including capturing audio, text-to-speech, speech-to-text, and speech-to-speech translation.

## Architecture

SpeechFlow uses a modular node-based architecture with three main components:

- **speechflow-cli**: Core TypeScript-based CLI engine that orchestrates processing flows
- **speechflow-ui-db**: Dashboard UI component for real-time visualization 
- **speechflow-ui-st**: Subtitle UI component for displaying live subtitles

### Processing Node Categories

- **Input/Output (xio)**: file, device, websocket, mqtt
- **Audio-to-Audio (a2a)**: ffmpeg, wav, mute, meter, vad, gender, gain, filler, compressor, expander, rnnoise, speex
- **Audio-to-Text (a2t)**: deepgram, amazon, openai
- **Text-to-Text (t2t)**: deepl, google, amazon, openai, ollama, transformers, subtitle, format, sentence, modify
- **Text-to-Audio (t2a)**: elevenlabs, kokoro, amazon
- **Any-to-Any (x2x)**: filter, trace

## Development Commands

```bash
# Top-level commands (from root directory)
npm start lint          # Lint all components (TypeScript, ESLint, Biome, Oxlint)
npm start build         # Build all components (full production build)
npm start clean         # Remove generated files
npm start upd           # Update all NPM dependencies

# Component-specific development (from speechflow-cli/)
npm start dev           # Multi-pane dashboard with linting, building, and server
npm start lint          # Static code analysis
npm start build         # Compile TypeScript to JavaScript
npm start server        # Run the main speechflow program
npm start clean         # Clean generated files

# Testing
npm start test          # Run test configuration with sample pipeline
```

## Key Implementation Files

### Core Engine

- `speechflow-cli/src/speechflow.ts`       -- CLI entry point
- `speechflow-cli/src/speechflow-main*.ts` -- Main program and orchestration
- `speechflow-cli/src/speechflow-node*.ts` -- Base node classes with stream processing
- `speechflow-cli/src/speechflow-util*.ts` -- Utility functions and helpers

### Node Implementations

All node implementations follow the pattern `speechflow-node-{category}-{name}.ts` in `speechflow-cli/src/`.

### Stream Processing Architecture

- Uses Node.js object-mode streams with timestamp metadata
- Audio chunks: PCM format, 16-bit, 16kHz, mono
- Text chunks: Include timing information and metadata (gender, final/interim)
- All streams maintain chronological timestamps for synchronization

## API Integration

REST/WebSocket API available on port 8484 (configurable) for:
- External node control (muting, configuration)
- Real-time metrics (audio levels, text flow)
- Dashboard and UI connectivity

## Environment Configuration

Key environment variables for service integrations:
- `SPEECHFLOW_DEEPGRAM_KEY` - Deepgram API key
- `SPEECHFLOW_ELEVENLABS_KEY` - ElevenLabs API key  
- `SPEECHFLOW_DEEPL_KEY` - DeepL API key
- `SPEECHFLOW_OPENAI_KEY` - OpenAI API key
- `SPEECHFLOW_GOOGLE_KEY` - Google Cloud API key
- `SPEECHFLOW_AWS_ACCESS_KEY_ID` - AWS access key
- `SPEECHFLOW_AWS_SECRET_ACCESS_KEY` - AWS secret key
- `SPEECHFLOW_AWS_REGION` - AWS region
- `SPEECHFLOW_DEVICE_MIC` - Microphone device identifier
- `SPEECHFLOW_DEVICE_SPK` - Speaker device identifier

## Flow Expression Language

Based on FlowLink with support for:
- Sequential pipelines: `node1 | node2 | node3`
- Parallel branches: `node1, node2, node3`  
- Grouping: `{ node1 | node2 }`
- Parameters: `node(param1: value, param2: "string")`
- Environment variables: `env.VARIABLE_NAME`
- Command arguments: `argv.0`, `argv.1`

## Testing Approach

Run tests using the test configuration:
```bash
npm start test
```

This executes a sample pipeline defined in `etc/speechflow.yaml` with dashboard visualization.

## Important Patterns

1. **Stream Processing**: All nodes extend `SpeechFlowNode` and implement `process()` method for stream transformation
2. **Error Handling**: Nodes emit errors via stream events, captured and logged centrally
3. **Timestamp Preservation**: Audio/text chunks maintain timing for synchronization across pipeline
4. **Meta Information**: Chunks carry metadata (gender, final/interim status) for downstream filtering

