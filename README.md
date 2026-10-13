# AIFLUX ✳

**A beautiful, practical workspace for building with AI.** Chat with free-model and free-tier providers, turn generated code into editable files, and preview a small web project—all in one place.

> AIFLUX is an interface, not a model host. It does **not** ship API keys or promise unlimited AI usage. Bring your own free-tier key, configure a server-side key, or connect a local Ollama server. Provider availability, quotas, and terms are controlled by the providers.

## Get started

Requires **Node.js 22+** and npm.

```bash
npm install
cp .env.example .env   # optional; you can also add keys in the app
npm run dev
```

Open `http://localhost:3000`. Click **Connect a model**, paste a key from a provider, select a model, and start chatting. The API key is held in **session storage by default**; checking “Remember on this device” uses local storage instead. Alternatively, set a key in `.env` on the server.

```bash
npm run build     # TypeScript check + production client
npm start         # serve the built app and API
npm test          # provider and workspace tests
```

## AI connections

| Provider | Included choices | How to connect |
| --- | --- | --- |
| **OpenRouter** | **Poolside Laguna S 2.1** (coding specialist), **Cohere North Mini Code** (fast coding), Laguna XS, Inkling, Nemotron 3 Ultra, and live-discovered `:free` chat models | Create a free API key at [OpenRouter](https://openrouter.ai/keys); add it in Settings or use `OPENROUTER_API_KEY`. |
| **Google Gemini** | **Gemini 3.8 Flash** (overall recommendation for software engineering), 2.5 Flash, 2.5 Flash-Lite | Create a key in [Google AI Studio](https://aistudio.google.com/apikey); add it in Settings or use `GEMINI_API_KEY`. |
| **Groq** | GPT-OSS 120B, Qwen 3.8 27B, GPT-OSS 20B | Create a key in [GroqCloud](https://console.groq.com/keys); add it in Settings or use `GROQ_API_KEY`. |
| **Ollama** | Your installed local conversational models, discovered from `/api/tags` | Run [Ollama](https://github.com/ollama/ollama) on the **same host as the AIFLUX server**, set `OLLAMA_BASE_URL=http://127.0.0.1:11434`, pull a model, and refresh the model library. No cloud API key required. |

**Why no “Auto free”?** OpenRouter's [`openrouter/free` router](https://openrouter.ai/docs/guides/routing/routers/free-router) picks a random free model; its catalog also includes [content-safety classifiers](https://openrouter.ai/nvidia/nemotron-3.5-content-safety:free) that answer with labels such as “User Safety: safe” instead of code. AIFLUX now rejects the random router and recognizable non-chat model IDs, filters moderation/embedding/reranking endpoints out of live discovery using model metadata, and stops a stream if the provider reports a safety/utility model. Older saved Auto-free selections are cleared automatically. An unlabelled or misleading third-party endpoint cannot be guaranteed to behave like a coding model.

**Which model to pick?** [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) is our overall recommendation for software-engineering tasks on a [Google free API tier](https://ai.google.dev/gemini-api/docs/pricing). If you use OpenRouter, start with [Poolside Laguna S 2.1](https://openrouter.ai/poolside/laguna-s-2.1:free), a coding-agent model with 262K context, or [Cohere North Mini Code](https://openrouter.ai/cohere/north-mini-code:free) for quicker iterations. AIFLUX prioritizes a model from a connected provider, respects your manual selection, and removes OpenRouter picks that disappear from the live free catalog. If discovery is unavailable, the curated picks remain visible, but provider availability must be checked at request time. Groq publishes [model IDs](https://console.groq.com/docs/models) and [plan rate limits](https://console.groq.com/docs/rate-limits).

**Free is not unlimited.** Availability, daily limits, regional eligibility, and free-tier terms can change. On Google's free tier, prompts may be used to improve its products; some OpenRouter free variants may also use inputs and outputs for training. Review each provider's terms before sending sensitive code. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Poolside free-model details](https://openrouter.ai/poolside/laguna-s-2.1:free)

## What you can do

- **Chat and code** with streamed answers, Markdown, code blocks, model switching, copy actions, and a persistent local conversation history.
- **Build in Canvas** using an editable syntax-highlighted CodeMirror editor. Named fenced code blocks (for example, one marked `html filename="index.html"`) from an AI answer become files automatically. Edited files are versioned rather than silently overwritten by a later answer.
- **Preview safely**: HTML or SVG projects can be previewed in a sandboxed iframe. Separate `.css` and `.js` files are included in the preview; external network requests are blocked. This is a web preview, **not** an unrestricted code execution environment or a React/TypeScript compiler.
- **Bring context** by attaching up to three text/code files (30 KB each) or adding a Canvas file to your next message. Export the current file, download the whole Canvas as a ZIP, or export a conversation as Markdown.
- **Keep control**: chats and code live in your browser's local storage; API keys aren't included in chat exports. Delete a conversation to remove its files from this browser.

## Configuration and deployment

Copy `.env.example` and set any combination of these values:

```dotenv
OPENROUTER_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
OLLAMA_BASE_URL=
AIFLUX_ACCESS_CODE=
PORT=3000
```

- User-provided keys take precedence over server keys for that request. The browser sends a selected key to the AIFLUX server; the server forwards it only to the selected provider over HTTPS. Keys are not written to server storage or logs by AIFLUX.
- If deploying with **shared server-side keys**, set `AIFLUX_ACCESS_CODE` at a minimum. Visitors must enter it in Settings before sending requests. This is a **shared gate**, not user accounts or a replacement for a proper auth gateway. Protect public instances with authentication and usage controls.
- The server only calls fixed provider URLs or the operator-configured Ollama URL. OpenRouter requests must target a specific `:free` chat model; the random router, known safety/utility model IDs, and paid variants are rejected even when requested directly via the API. The server also applies a basic per-IP request limit and a two-minute upstream timeout.
- Run behind HTTPS in production. Browser storage is not an encrypted vault; avoid “Remember on this device” on shared computers. Review your provider's data-handling policy before sending private code.
- AIFLUX is a browser-based AI coding **workspace**, not an autonomous repository agent. It doesn't execute shell commands, install packages, or edit files on the server on a user's behalf.

### Deploy on Vercel

This repository includes `vercel.json` for the Vite frontend and `api/*.js` Vercel Functions for the chat, config, and model-catalog endpoints. When the repository is linked to Vercel, pushing a branch creates a **preview deployment**; production deploys from the Vercel project's production branch (usually `main`). No API key is required to build or view the UI, but live cloud chat needs a user key or a server key configured under **Vercel → Project Settings → Environment Variables**. Never commit a `.env` file.

If you use a shared `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY` on Vercel, also set `AIFLUX_ACCESS_CODE` and put the app behind appropriate authentication before inviting public traffic. `OLLAMA_BASE_URL=http://127.0.0.1:11434` works only when AIFLUX and Ollama run on the **same machine**; it will not reach your laptop from Vercel's cloud.

### Project structure

```text
src/                 React UI, Canvas, model library, local workspace state
src/lib/             file parsing, preview builder, streaming client, storage
api/*.js             Vercel serverless entrypoints for the same API
server/api-app.mjs   Shared Express API routes
server/index.mjs     Local Node server + Vite dev middleware / production assets
server/providers.mjs provider adapters, validation, free-model discovery, SSE parsing
vercel.json          Vite build and SPA routing configuration
```

## Verified locally

`npm test` covers the Vercel function entrypoints, provider request validation, free-only OpenRouter routing, rejection of random/safety/utility models (including unexpected classifier streams and saved browser selections), Gemini/Groq/Ollama request formats, SSE parsing, error redaction, code-file extraction, and preview sandbox generation. `npm run build` checks the TypeScript app and builds the production bundle. A browser smoke test of chat → generated file → preview → persistence used a simulated streamed AI response; live provider calls require your own key and outbound access to that provider.

---

Made for curious builders. **Make room for what’s next.**
