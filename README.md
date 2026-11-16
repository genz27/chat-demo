# chat-demo

English | [简体中文](README.zh-CN.md)

A chat application powered by the OpenAI-compatible API at haqimi.uk. Docker/Nginx injects the API key server-side, so the browser never asks users to enter a key.

Only DeepSeek V4.1 Flash and Grok 4.7 are available. Deep thinking and smart search are disabled.

## Getting started

Install Node.js 22.12+ and pnpm, then run `pnpm install` and `pnpm dev`. Open http://localhost:8090.

## Docker deployment

Copy `.env.example` to `.env`, set `CHAT_API_KEY` (never commit `.env`), and start the proxy:

```sh
cp .env.example .env
docker compose up --build -d
```

Open http://localhost:8080. Nginx proxies `/v1` to haqimi.uk and adds the server-side key.

## Features

- Multiple conversations with automatic titles, renaming, editing, regeneration, and message branches.
- Streaming replies, stop/continue controls, and a DeepSeek/Grok model selector.
- Attachment upload, voice input, read-aloud replies, Markdown, syntax highlighting, KaTeX, and Mermaid.
- Simplified Chinese and English, light/dark themes, mobile layouts, and location settings.

## Data and configuration

The deployment key comes from `CHAT_API_KEY`; it is not stored in the repository. Conversations and attachments are stored in IndexedDB. Settings only contains theme, language, voice, and location preferences.

[rspack.config.ts](rspack.config.ts) defaults to `https://haqimi.uk`; Docker uses a same-origin `/v1` proxy. Chat uses `/v1/chat/completions` with `deepseek-v4.1-flash` or `grok-4.7`; speech uses `/v1/tools/asr` and `/v1/tools/tts`.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
