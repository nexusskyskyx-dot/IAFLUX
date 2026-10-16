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
| **xKiro** | Every currently free chat model from its live catalog, including coding and general models; models without a `:free` suffix are included | Create a key at the [xKiro API Keys page](https://xkiro.com/dashboard/api/keys); add it in Settings or use `XKIRO_API_KEY`. Free models draw from a daily token allowance. |
| **Google Gemini** | **Gemini 3.8 Flash** (overall recommendation for software engineering), 2.5 Flash, 2.5 Flash-Lite; a personal key discovers additional models available to that key | Create a key in [Google AI Studio](https://aistudio.google.com/apikey); add it in Settings or use `GEMINI_API_KEY`. |
| **Groq** | GPT-OSS 120B, Qwen 3.8 27B, GPT-OSS 20B; a personal key discovers additional models available to that key | Create a key in [GroqCloud](https://console.groq.com/keys); add it in Settings or use `GROQ_API_KEY`. |
| **Ollama** | Your installed local conversational models, discovered from `/api/tags` | Run [Ollama](https://github.com/ollama/ollama) on the **same host as the AIFLUX server**, set `OLLAMA_BASE_URL=http://127.0.0.1:11434`, pull a model, and refresh the model library. No cloud API key required. |

**xKiro's free list stays live.** AIFLUX reads xKiro's public [model catalog](https://api.xkiro.com/v1/models) and only includes entries marked `modality: chat` and `access_tier: free` with zero input/output token prices (and no nonzero cache prices). The free list is not hardcoded or determined by an ID suffix; refresh the library to discover additions. If AIFLUX cannot verify the current catalog, xKiro chat requests fail closed rather than risk routing to a paid model. xKiro's [pricing guide](https://docs.xkiro.com/guides/pricing/) says free models have a daily token allowance, so free access is capped—not unlimited.

**Why no “Auto free”?** OpenRouter's [`openrouter/free` router](https://openrouter.ai/docs/guides/routing/routers/free-router) picks a random free model; its catalog also includes [content-safety classifiers](https://openrouter.ai/nvidia/nemotron-3.5-content-safety:free) that answer with labels such as “User Safety: safe” instead of code. AIFLUX now rejects the random router and recognizable non-chat model IDs, filters moderation/embedding/reranking endpoints out of live discovery using model metadata, and stops a stream if the provider reports a safety/utility model. Older saved Auto-free selections are cleared automatically. Existing chat transcripts are not rewritten: if an earlier answer contains safety labels, resend your prompt with a named coding model. An unlabelled or misleading third-party endpoint cannot be guaranteed to behave like a coding model.

**Which model to pick?** [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) is our overall recommendation for software-engineering tasks on a [Google free API tier](https://ai.google.dev/gemini-api/docs/pricing). If you use OpenRouter, start with [Poolside Laguna S 2.1](https://openrouter.ai/poolside/laguna-s-2.1:free), a coding-agent model with 262K context, or [Cohere North Mini Code](https://openrouter.ai/cohere/north-mini-code:free) for quicker iterations. When a Gemini or Groq key is saved, AIFLUX queries that provider's model catalog; xKiro and OpenRouter catalogs are already discovered live. In **Settings**, you can leave **Auto-select a recommended model on connect** enabled or switch it off to keep your current/manual choice. Automatic recommendations only select known free-tier picks; additional Gemini/Groq models discovered with a personal key are marked **CHECK PRICING** and require a manual choice. Review each provider's pricing and account limits before using them. If discovery is unavailable, curated picks remain visible, but provider availability must be checked at request time. Groq publishes [model IDs](https://console.groq.com/docs/models) and [plan rate limits](https://console.groq.com/docs/rate-limits).

**Free is not unlimited.** Availability, daily limits, regional eligibility, and free-tier terms can change. xKiro free models use a daily token allowance; check its [pricing guide](https://docs.xkiro.com/guides/pricing/) and account usage. On Google's free tier, prompts may be used to improve its products; some OpenRouter free variants may also use inputs and outputs for training. Review each provider's terms before sending sensitive code. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Poolside free-model details](https://openrouter.ai/poolside/laguna-s-2.1:free)

## Context+ reference libraries

Every provider request receives a small server-owned **Context+** prompt library. AIFLUX selects relevant notes for web-design inspiration, frontend/component and backend/API/data libraries, coding practice, testing, security/privacy, accessibility, library/product research, reasoning, and conversation/writing; users can ask what the library contains to see the full catalog. These curated notes guide answers but are **not** installed packages, a live documentation mirror, a verified popularity list, or a substitute for the repository's existing stack and official docs. Design-inspiration examples include [Awwwards](https://www.awwwards.com/), [Godly](https://godly.website/), [Mobbin](https://www.mobbin.com/), [Lapa Ninja](https://www.lapa.ninja/), and [Dribbble](https://dribbble.com/); use them as references rather than copying another creator's work.

For current versions, releases, trends, adoption, availability, or pricing, set **Web** to **Auto** or **Always** so AIFLUX can verify with live search and show sources. In Auto, current library/framework/UI/design-trend questions trigger a live lookup even if the selected model's search planner tries to skip it. **Off remains fully off**: no live lookup is sent, and current claims are not presented as verified. Context+ itself is a bounded prompt feature and adds no dependency or external documentation fetch.

## Live web search

In the chat composer, click **Web** to cycle **Off → Auto → Always**. Off (the default) makes no search requests; Auto lets the selected AI decide whether current information would help, with a forced live lookup for current library/framework/UI/design-trend questions; Always attempts a web search before each answer. Search requires a connected AI model. When it runs, you see progress and up to five clickable source links alongside the answer; if Auto skips a non-trend search or Always cannot find a safe query, the answer explicitly says no live search was used. The AI is asked to cite the numbered sources, but you should open links to verify important claims yourself. A failed search is shown as an error, not silently presented as a current answer.

Search uses [Tavily](https://docs.tavily.com/documentation/keyless). Rate-limited **keyless** search works without signup or a Tavily key; for your own allowance, add a [free Tavily key](https://app.tavily.com/) in **Settings → Live web search**, or set `TAVILY_API_KEY` on the server. User keys override the server key. Tavily's free-account credits and keyless quotas can change; [check its current pricing/credits](https://docs.tavily.com/documentation/api-credits). Each Auto/Always message may add one non-streaming AI planning call; if a search runs, it also uses a Tavily search and the normal AI answer call, consuming their respective allowances.

**Privacy:** The AI planner sees the latest question (appended code-file attachments are stripped for planning), and only a bounded query—not the whole conversation—is sent to Tavily. The selected AI receives the search snippets and your original chat context to write the answer. We reject common secret patterns in search queries, but cannot guarantee that arbitrary private information in your question will be caught. **Don't enable search for sensitive prompts.** Tavily results are treated as untrusted data, not instructions. Search mode is remembered locally; the optional Tavily key follows the same session-storage / “Remember on this device” setting as AI keys.

## GitHub context and user-approved publishing

Click the GitHub icon in the chat composer to authorize the AIFLUX GitHub App and browse repositories where it is installed. Users can preview a bounded list of source files, open issues, and pull requests, then explicitly add selected context to a message. AI-generated named code files appear in Canvas. From Canvas, users can select files, review the current and proposed contents, and explicitly choose **Create a draft pull request** (the default, on a new branch) or **Push directly** to an existing branch. AIFLUX never writes automatically: every publish requires review and confirmation, and direct pushes require an extra confirmation. Branch protections still apply. Publishing is limited to 20 text/code files per operation, 30 KB per file and 150 KB total; sensitive paths such as `.env` and private keys are blocked. Issue contents remain read-only; AIFLUX does not edit issues. Never paste a GitHub token into chat.

The workspace operator must create a **GitHub App** (not a standalone classic OAuth App) so users can authorize access to repositories with fine-grained permissions. Configure **Contents: Read and write**, **Pull requests: Read and write**, and **Issues: Read-only**; Metadata is read-only by default. Contents write is required to publish files; Pull requests write is additionally required for the draft-PR option. Choose **Any account** for where the App can be installed if other users or organizations should connect; organization owners may need to approve installation. Install it only on repositories that should be available. Set the App's **User authorization callback URL** to `https://YOUR_DOMAIN/api/github` (AIFLUX uses the browser authorization-code flow with PKCE and requests `offline_access` so the server can refresh expiring user tokens). Keep expiring user tokens enabled and device flow disabled. Add these server-side environment variables:

```dotenv
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=https://YOUR_DOMAIN/api/github
GITHUB_APP_INSTALL_URL=https://github.com/apps/YOUR_APP_SLUG/installations/new # optional
GITHUB_SESSION_SECRET= # at least 32 random characters; e.g. openssl rand -hex 32
```

Set the same callback URL in the GitHub App settings and in the server environment. `GITHUB_APP_INSTALL_URL` is optional; when set to the app's `https://github.com/apps/<slug>/installations/new` URL, the repository browser can link directly to installation. For Vercel, add these values under the project's Environment Variables and redeploy. Each person authorizes their own GitHub account; the access/refresh tokens never enter browser storage or the AI request. AIFLUX keeps them in an encrypted, HttpOnly, SameSite=Lax cookie and refreshes expiring user tokens server-side. Only HTTPS deployments set the Secure cookie flag. If permissions change, users may need to approve the updated installation; if the session secret changes, connected users need to reconnect.

## AIFLUX assistant identity

Every chat request sends a **server-owned system instruction** to the selected model, including follow-up turns. It tells the model it is **AIFLUX**, not the underlying provider, and describes the workspace's actual features and limitations: chat/code, Canvas, sandbox preview, attachments, Context+ reference notes, live search, models, and local exports. The server adds only the Context+ packs relevant to the latest user message. Web-search guidance reflects **this request's** Off/Auto/Always state and only says a search happened when the server supplied results. The internal search planner also identifies as AIFLUX, but does not answer the user. No one needs to paste an identity prompt into each model's Settings.

**When shipping a new feature:** update `AIFLUX_FEATURES`, relevant behavior/limitations in `server/assistant-profile.mjs`, and curated notes or selection rules in `server/context-libraries.mjs` alongside the UI/API and this README. The server builds the prompt from that profile on every answer, including sourced and skipped-search replies. Run `npm test`—the profile and Context+ tests check behavior across providers. Do not advertise features before they are available or claim the assistant can run commands, directly inspect Canvas edits, or deploy code.

## What you can do

- **Chat and code** with streamed answers, Markdown, optional live web search with source links, code blocks, model switching, copy actions, and a persistent local conversation history.
- **Build in Canvas** with **View**, **Edit**, **Test**, and **Diff** modes. Click **Edit with AI** to send the selected file’s full contents to AIFLUX; the composer labels it **Canvas · filename**, and the attachment stays active across follow-ups until removed. AIFLUX reads the attached file instead of asking which file; describe the change you want. The app updates only that attached file if it has not changed since it was shared. The Diff view shows additions in green and deletions in red, with an option to restore the previous version. Filename collisions with existing user-edited or AI-generated files create a separate version unless that exact Canvas file was attached for editing, preserving existing work. Test renders HTML/SVG in an isolated sandbox; it is not a shell or unit-test runner. Named fenced code blocks (for example, `html filename="index.html"`) still create new Canvas files automatically.
- **Publish GitHub changes** from Canvas after reviewing selected file contents: create a draft pull request on a new branch by default, or explicitly confirm a direct push to an existing branch. No writes happen automatically; issues are not edited.
- **Preview safely**: HTML or SVG projects can be tested in a sandboxed iframe. Separate `.css` and `.js` files are included. External resources are blocked by default; inline/data images work. In **Test**, users can explicitly switch on HTTPS image loading for generated image URLs—this may reveal their IP address to the image host, while external scripts, fetch/XHR, and forms remain blocked. The preview is **not** an unrestricted code execution environment, shell, unit-test runner, or React/TypeScript compiler.
- **Bring context** by attaching up to three text/code files (30 KB each), attaching the selected Canvas file until you remove its composer chip, or selecting an installed GitHub repository file/issue/pull request for your next message. Export the current file, download the whole Canvas as a ZIP, or export a conversation as Markdown.
- **Keep control**: chats and code live in your browser's local storage; API keys aren't included in chat exports. Delete a conversation to remove its files from this browser.

## Configuration and deployment

Copy `.env.example` and set any combination of these values:

```dotenv
OPENROUTER_API_KEY=
XKIRO_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
TAVILY_API_KEY=
OLLAMA_BASE_URL=
AIFLUX_ACCESS_CODE=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=https://YOUR_DOMAIN/api/github
GITHUB_APP_INSTALL_URL=https://github.com/apps/YOUR_APP_SLUG/installations/new
GITHUB_SESSION_SECRET=
PORT=3000
```

- User-provided keys take precedence over server keys for that request. The browser sends the selected AI key (and, if search is enabled, an optional Tavily key) to the AIFLUX server; the server forwards each only to its respective provider over HTTPS. Gemini/Groq keys are also used to discover models for that provider. Keys are not written to server storage or logs by AIFLUX. Additional key-discovered models may have different prices or limits; verify before use.
- If deploying with **shared server-side keys**, including `TAVILY_API_KEY`, set `AIFLUX_ACCESS_CODE` at a minimum. Visitors must enter it in Settings before sending requests. This is a **shared gate**, not user accounts or a replacement for a proper auth gateway. Protect public instances with authentication and usage controls.
- The server only calls fixed AI provider/Tavily URLs or the operator-configured Ollama URL. OpenRouter requests must target a specific `:free` chat model; the random router, known safety/utility model IDs, and paid variants are rejected even when requested directly via the API. xKiro requests must match a freshly verified live catalog entry marked free with zero input/output prices; the server fails closed if it cannot verify the current tier. The server applies basic per-IP limits (60 chat requests and 12 search-enabled requests per 10 minutes per running instance) and a two-minute request timeout. Serverless instances may each have their own counters, and host-level timeouts can be shorter; these controls are not a substitute for authentication.
- Run behind HTTPS in production. Browser storage is not an encrypted vault; avoid “Remember on this device” on shared computers. Review your provider's data-handling policy before sending private code.
- AIFLUX is a browser-based AI coding **workspace**, not an autonomous repository agent. It doesn't execute shell commands or install packages. It can publish selected Canvas files to GitHub only after the user reviews the exact contents and explicitly confirms a draft PR or direct push.

### Deploy on Vercel

This repository includes `vercel.json` for the Vite frontend and `api/*.js` Vercel Functions for chat, config, model catalogs/discovery, and GitHub OAuth/context plus user-approved publish endpoints. When the repository is linked to Vercel, pushing a branch creates a **preview deployment**; production deploys from the Vercel project's production branch (usually `main`). No API key is required to build or view the UI, but live cloud chat needs a user key or a server key configured under **Vercel → Project Settings → Environment Variables**. GitHub OAuth requires the client ID, client secret, callback URL, and session secret described above; the app-install URL is optional. The GitHub App callback must match the deployed domain. Never commit a `.env` file.

If you use a shared `OPENROUTER_API_KEY`, `XKIRO_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, **or `TAVILY_API_KEY`** on Vercel, also set `AIFLUX_ACCESS_CODE` and put the app behind appropriate authentication before inviting public traffic. Without `TAVILY_API_KEY`, the chat function tries Tavily's rate-limited keyless API; visitors can supply their own key in Settings. `OLLAMA_BASE_URL=http://127.0.0.1:11434` works only when AIFLUX and Ollama run on the **same machine**; it will not reach your laptop from Vercel's cloud.

### Project structure

```text
src/                 React UI, Canvas modes, model library, local workspace state
src/components/CanvasDiff.tsx  colored, line-numbered Canvas change review
src/lib/             file parsing, Canvas diffing, preview builder, streaming client, storage
api/*.js             Vercel serverless entrypoints for the same API
server/api-app.mjs   Shared Express API routes
server/github.mjs    GitHub App OAuth, encrypted sessions, context reads, and confirmed publishing
server/index.mjs     Local Node server + Vite dev middleware / production assets
server/providers.mjs provider adapters, validation, model discovery, SSE parsing
server/assistant-profile.mjs  AIFLUX identity, shipped capability list, per-request search guidance
server/context-libraries.mjs  curated Context+ notes and request-matched pack selection
server/search.mjs    AI search planning, Tavily requests, source normalization
vercel.json          Vite build and SPA routing configuration
```

## Verified locally

`npm test` covers the Vercel function entrypoints, provider request validation, free-only OpenRouter routing, live xKiro free-tier/zero-price discovery and paid-model rejection, Gemini/Groq key-scoped model discovery, GitHub App OAuth/session, repository/file/issue/PR reads, and user-confirmed branch/PR write flows, the AIFLUX identity/capability profile and request-matched Context+ packs across providers, automatic live lookup for current library/design trends, AI tool planning, Tavily keyless/keyed calls and source sanitization, search/answer streaming, SSE parsing, error redaction, code-file extraction, and preview sandbox generation. External GitHub, AI, model-catalog, and Tavily requests are **mocked** in these tests; real integrations require valid keys and provider access. `npm run build` checks the TypeScript app and builds the production bundle.

---

Made for curious builders. **Make room for what’s next.**
