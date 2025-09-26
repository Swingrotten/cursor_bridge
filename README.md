# Cursor Bridge

OpenAI compatible API bridge for Cursor.com using browser automation.

## Features

- Provides OpenAI-compatible `/v1/chat/completions` endpoint
- Supports multiple AI models (GPT-5, Claude Opus 4.1, Sonnet 4, Gemini 2.5 Pro, DeepSeek V3.1)
- Streaming responses via Server-Sent Events
- Browser automation using Puppeteer
- Automatic session management

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

The API server will start on `http://localhost:8000`

## API Endpoint

POST `/v1/chat/completions`

Compatible with OpenAI API format:

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true
}
```

## Environment Variables

- `PORT`: Server port (default: 8000)
- `HEADLESS`: Run browser in headless mode (default: true)
- `DEBUG`: Enable debug logging (default: false)