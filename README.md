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
| **xKiro** | **Qwen3 Coder Plus** (1.05M context), **Codestral**, **North Mini Code**, **Devstral 2**, Qwen3.8 Max, Mistral Large 4, and live-discovered free models | Create a free key at [xKiro](https://xkiro.com/register); add it in Settings or use `XKIRO_API_KEY`. |

**Why no “Auto free”?** OpenRouter's [`openrouter/free` router](https://openrouter.ai/docs/guides/routing/routers/free-router) picks a random free model; its catalog also includes [content-safety classifiers](https://openrouter.ai/nvidia/nemotron-3.5-content-safety:free) that answer with labels such as “User Safety: safe” instead of code. AIFLUX now rejects the random router and recognizable non-chat model IDs, filters moderation/embedding/reranking endpoints out of live discovery using model metadata, and stops a stream if the provider reports a safety/utility model. Older saved Auto-free selections are cleared automatically. Existing chat transcripts are not rewritten: if an earlier answer contains safety labels, resend your prompt with a named coding model. An unlabelled or misleading third-party endpoint cannot be guaranteed to behave like a coding model.

**Which model to pick?** [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) is our overall recommendation for software-engineering tasks on a [Google free API tier](https://ai.google.dev/gemini-api/docs/pricing). If you use OpenRouter, start with [Poolside Laguna S 2.1](https://openrouter.ai/poolside/laguna-s-2.1:free), a coding-agent model with 262K context, or [Cohere North Mini Code](https://openrouter.ai/cohere/north-mini-code:free) for quicker iterations. AIFLUX prioritizes a model from a connected provider, respects your manual selection, and removes OpenRouter picks that disappear from the live free catalog. If discovery is unavailable, the curated picks remain visible, but provider availability must be checked at request time. Groq publishes [model IDs](https://console.groq.com/docs/models) and [plan rate limits](https://console.groq.com/docs/rate-limits).

**How free status is checked.** OpenRouter exposes free variants with a `:free` id, so AIFLUX accepts only specific `:free` chat ids. xKiro instead publishes an `access_tier` field on its public [model catalogue](https://docs.xkiro.com/api/list-models/), and its free ids use mixed conventions — some end in `:free`, some do not — so an id alone cannot tell you whether a model is free. AIFLUX therefore filters xKiro's live catalogue by `access_tier: free` and refuses models it did not list as free; if the catalogue is unreachable, only the curated picks and the `vendor/model` id shape are enforced and availability is not verified until you send a request. Free status is always re-checked at request time by the provider.

**Free is not unlimited.** Availability, daily limits, regional eligibility, and free-tier terms can change. On Google's free tier, prompts may be used to improve its products; some OpenRouter free variants may also use inputs and outputs for training. Review each provider's terms before sending sensitive code. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Poolside free-model details](https://openrouter.ai/poolside/laguna-s-2.1:free)

## Live web search

In the chat composer, click **Web** to cycle **Off → Auto → Always**. Off (the default) makes no search requests; Auto lets the selected AI decide whether current information would help; Always attempts a web search before each answer. Search requires a connected AI model. When it runs, you see progress and up to five clickable source links alongside the answer; if Auto skips a search or Always cannot find a safe query, the answer explicitly says no live search was used. The AI is asked to cite the numbered sources, but you should open links to verify important claims yourself. A failed search is shown as an error, not silently presented as a current answer.

Search uses [Tavily](https://docs.tavily.com/documentation/keyless). Rate-limited **keyless** search works without signup or a Tavily key; for your own allowance, add a [free Tavily key](https://app.tavily.com/) in **Settings → Live web search**, or set `TAVILY_API_KEY` on the server. User keys override the server key. Tavily's free-account credits and keyless quotas can change; [check its current pricing/credits](https://docs.tavily.com/documentation/api-credits). Each Auto/Always message may add one non-streaming AI planning call; if a search runs, it also uses a Tavily search and the normal AI answer call, consuming their respective allowances.

**Privacy:** The AI planner sees the latest question (appended code-file attachments are stripped for planning), and only a bounded query—not the whole conversation—is sent to Tavily. The selected AI receives the search snippets and your original chat context to write the answer. We reject common secret patterns in search queries, but cannot guarantee that arbitrary private information in your question will be caught. **Don't enable search for sensitive prompts.** Tavily results are treated as untrusted data, not instructions. Search mode is remembered locally; the optional Tavily key follows the same session-storage / “Remember on this device” setting as AI keys.

## AIFLUX assistant identity

Every chat request sends a **server-owned system instruction** to the selected model, including follow-up turns. It tells the model it is **AIFLUX**, not the underlying provider, and describes the workspace's actual features and limitations: chat/code, Canvas, sandbox preview, attachments, live search, models, and local exports. Web-search guidance reflects **this request's** Off/Auto/Always state and only says a search happened when the server supplied results. The internal search planner also identifies as AIFLUX, but does not answer the user. No one needs to paste an identity prompt into each model's Settings.

**When shipping a new feature:** update `AIFLUX_FEATURES` and any relevant behavior/limitations in `server/assistant-profile.mjs` alongside the UI/API and this README. The server builds the prompt from that one profile on every answer, including sourced and skipped-search replies. Run `npm test`—the profile tests check that its entries reach every provider. Do not advertise features before they are available or claim the assistant can run commands, visually inspect its own output, or deploy code.

## What you can do

- **Chat and code** with streamed answers, Markdown, optional live web search with source links, code blocks, model switching, copy actions, and a persistent local conversation history.
- **The AI writes to Canvas, not to chat.** When an answer creates or changes code, the model emits tagged blocks that the server lifts out of the stream and applies straight to the Canvas — the transcript keeps only the explanation plus a `file +12 −4` chip you can click to open the diff. Two forms are supported: `<aiflux-write path="…">` with the complete file, and `<aiflux-patch path="…">` with `SEARCH`/`REPLACE` hunks for a targeted edit. The model is told which files already exist and is given the contents of whatever fits a 40k-character budget, so it patches accurately instead of rewriting blind — and has no reason to invent a way to read them. Files too large to send are listed by name so it can ask for them. A failed patch is reported instead of corrupting the file.
- **The AI can read a web page.** With `<url_fetch>https://…</url_fetch>` the assistant asks for a page and the server fetches it — the browser can't, and the model has no network of its own. The result comes back as another turn rather than stalling the stream mid-sentence, so the model never sits waiting on an HTTP request. Pages are returned as text plus the design signals a screenshot can't give you: fonts, colour tokens, CSS custom properties, heading structure, and — on a design gallery — the list of sites it's featuring. Every page the assistant opens is shown as a chip under the answer, so you can check where its references came from. Up to three pages per round and two rounds per answer. **The fetcher is hardened against SSRF**: only http(s), no embedded credentials, and every redirect hop is DNS-resolved and checked against the private, loopback, link-local and cloud-metadata ranges, so a public URL can't bounce to `127.0.0.1` or `169.254.169.254` after the first check. `robots.txt` is fetched and honoured, including wildcards and `$` anchors, with longest-match winning. Responses are capped at 2 MB, redirects at three, and the whole request at 12 s. Browsing is rate-limited separately from chatting.
- **Design knowledge for web work — and real references, fetched for it.** When a request is about a site, page, or interface, the prompt gains a design playbook: pick an archetype first, compose from named sections (hero, value proposition, features, pricing, FAQ, footer…), a fluid type scale, one neutral ramp plus one accent, motion that respects `prefers-reduced-motion`, and an accessibility floor. It also names the defaults that give machine-generated pages away — purple-gradient heroes, three identical feature cards, placeholder copy, emoji for icons — and warns that the Canvas preview sandbox has no network, so fonts and frameworks must be local files. The curated galleries ([Landbook](https://land-book.com/), [Godly](https://godly.design/), [Awwwards](https://www.awwwards.com/)) are supplied with their real URLs, by page type and by section, so the assistant can open a reference instead of inventing one.

  Offering that was not enough: asked for a landing page, a model starts writing code immediately and never browses, because writing is the instruction it is straining to obey. So the server opens the references itself, **before the model's first token** — the gallery matching the request (`landing page` → Landbook's landing-page index), then one of the sites that gallery is featuring, whose fonts, colour tokens, heading structure and copy the model can study. It cannot skip a step it never had to take. Results are cached for 30 minutes, the whole step is capped at 8s, and a gallery that is slow, blocked or unreachable costs a few seconds and changes nothing else: the model simply falls back on the playbook. Set `AIFLUX_PRIME_REFERENCES=0` to turn it off. It's injected only for design work, and it survives the turns after a page is fetched, because that's when the code gets written.
- **Build in Canvas** using an editable syntax-highlighted CodeMirror editor, with a **Changes** view that shows a line-by-line diff of the last thing the assistant wrote to the selected file. Models do not always comply in other ways. If one ignores the protocol and wraps its output in `<document>`, `<file>` or `<artifact>` instead, the server accepts those too: with a path they become a write, and without one the wrapper is stripped, the content is given a derived name, and it still reaches the Canvas. Plain fenced blocks with a filename work as well. A model that names nothing still loses nothing — its code stays visible in the reply and is not turned into a mystery file. Edited files are versioned rather than silently overwritten by a later answer.
- **Preview safely**: HTML or SVG projects can be previewed in a sandboxed iframe. Separate `.css` and `.js` files are included in the preview; external network requests are blocked. This is a web preview, **not** an unrestricted code execution environment or a React/TypeScript compiler.
- **Bring context** by attaching up to three text/code files (30 KB each) or adding a Canvas file to your next message. Export the current file, download the whole Canvas as a ZIP, or export a conversation as Markdown.
- **Keep control**: chats and code live in your browser's local storage; API keys aren't included in chat exports. Delete a conversation to remove its files from this browser.

## Configuration and deployment

Copy `.env.example` and set any combination of these values:

```dotenv
OPENROUTER_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
XKIRO_API_KEY=
TAVILY_API_KEY=
OLLAMA_BASE_URL=
AIFLUX_ACCESS_CODE=
AIFLUX_REQUEST_TIMEOUT_MS=
PORT=3000
```

- User-provided keys take precedence over server keys for that request. The browser sends the selected AI key (and, if search is enabled, an optional Tavily key) to the AIFLUX server; the server forwards each only to its respective provider over HTTPS. Keys are not written to server storage or logs by AIFLUX.
- If deploying with **shared server-side keys**, including `TAVILY_API_KEY`, set `AIFLUX_ACCESS_CODE` at a minimum. Visitors must enter it in Settings before sending requests. This is a **shared gate**, not user accounts or a replacement for a proper auth gateway. Protect public instances with authentication and usage controls.
- The server only calls fixed AI provider/Tavily URLs or the operator-configured Ollama URL. OpenRouter requests must target a specific `:free` chat model; the random router, known safety/utility model IDs, and paid variants are rejected even when requested directly via the API. The server applies basic per-IP limits (60 chat requests and 12 search-enabled requests per 10 minutes per running instance) and a request timeout. Serverless instances may each have their own counters, and host-level timeouts can be shorter; these controls are not a substitute for authentication.
- **Request budget:** `AIFLUX_REQUEST_TIMEOUT_MS` caps how long one answer may take. It defaults to **120 s self-hosted** and **55 s on Vercel**, so the server answers with a clear message instead of letting the platform kill the function mid-stream. Lower it if your host ends requests sooner.
- **Behind a proxy, AIFLUX trusts it.** On Vercel (or with `AIFLUX_TRUST_PROXY=1`) the app enables Express `trust proxy` so per-IP rate limiting keys on the visitor from `X-Forwarded-For` rather than the proxy's socket address. Enable it only when a proxy you control actually terminates the connection, otherwise visitors can spoof the header to get their own bucket.
- Run behind HTTPS in production. Browser storage is not an encrypted vault; avoid “Remember on this device” on shared computers. Review your provider's data-handling policy before sending private code.
- AIFLUX is a browser-based AI coding **workspace**, not an autonomous repository agent. It doesn't execute shell commands, install packages, or edit files on the server on a user's behalf.

### Deploy on Vercel

This repository includes `vercel.json` for the Vite frontend and `api/*.js` Vercel Functions for the chat, config, and model-catalog endpoints. When the repository is linked to Vercel, pushing a branch creates a **preview deployment**; production deploys from the Vercel project's production branch (usually `main`). No API key is required to build or view the UI, but live cloud chat needs a user key or a server key configured under **Vercel → Project Settings → Environment Variables**. Never commit a `.env` file.

On Vercel, each answer is one serverless invocation, so it is bound by the plan's function duration. `vercel.json` sets `functions.maxDuration` to **300 s** — the documented maximum on both Hobby and Pro — and the server stops itself just inside that wall at **290 s** rather than being killed at the platform limit. If your project is on an older configuration with a smaller ceiling, lower `AIFLUX_REQUEST_TIMEOUT_MS` to match it.

**Long answers resume instead of dying.** When that budget is reached while the model is still writing, the server ends the stream with a `truncated` event instead of an error. AIFLUX then sends the partial text back and asks the model to carry on from the exact character where it stopped, repeating up to **4** extra times. Everything already streamed is kept, so a large file arrives as one continuous answer — the chat just shows a brief "Picking the answer back up" note between attempts. Web search runs once, on the first attempt only. If the attempts run out, the answer is marked as having reached the limit so you can ask for the rest.

To go beyond 300 s on Pro/Enterprise, enable **Fluid Compute** (Settings → Functions, then redeploy) and set a function-level `maxDuration` up to **800 s**. Fluid bills active CPU time, so a stream that is waiting on the model costs very little.

If you use a shared `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, **or `TAVILY_API_KEY`** on Vercel, also set `AIFLUX_ACCESS_CODE` and put the app behind appropriate authentication before inviting public traffic. Without `TAVILY_API_KEY`, the chat function tries Tavily's rate-limited keyless API; visitors can supply their own key in Settings. `OLLAMA_BASE_URL=http://127.0.0.1:11434` works only when AIFLUX and Ollama run on the **same machine**; it will not reach your laptop from Vercel's cloud.

### Project structure

```text
src/                 React UI, Canvas, model library, local workspace state
src/lib/             file parsing, preview builder, streaming client, storage
api/*.js             Vercel serverless entrypoints for the same API
server/api-app.mjs   Shared Express API routes
server/index.mjs     Local Node server + Vite dev middleware / production assets
server/providers.mjs provider adapters, validation, free-model discovery, SSE parsing
server/assistant-profile.mjs  AIFLUX identity, shipped capability list, per-request search guidance
server/browse.mjs    Page fetching: SSRF guards, robots.txt, HTML→text, design extraction
server/design-profile.mjs  Web-design playbook, gallery references, design-request detection
server/design-references.mjs  Fetches design references before the model writes, cached and budgeted
server/search.mjs    AI search planning, Tavily requests, source normalization
vercel.json          Vite build and SPA routing configuration
```

## Verified locally

`npm test` covers the Vercel function entrypoints, provider request validation, free-only OpenRouter routing, rejection of random/safety/utility models, Gemini/Groq/Ollama request formats, the AIFLUX identity/capability profile on every provider and search path, AI tool planning, Tavily keyless/keyed calls and source sanitization, search/answer streaming, SSE parsing, error redaction, code-file extraction, preview sandbox generation, per-visitor rate limiting behind a proxy, the hosted request budget, resuming an answer that ran out of time, the canvas write protocol (tags split across stream chunks, incomplete blocks, wrapper tags models fall back on, invented tool calls, SEARCH/REPLACE hunks), the canvas context sent to the model, page fetching (SSRF guards, robots.txt, redirect re-validation, design extraction, gallery references), the design playbook and when it is injected, automatic reference priming (gallery selection, the featured-site follow-up, caching, the time budget, and degrading to nothing when a gallery cannot be read), applying writes/patches/deletes and their failure cases, resuming a write that a time limit cut short, line diffs, id/clipboard fallbacks for insecure (plain-HTTP) contexts, and xKiro request building, id validation, `access_tier` free filtering and end-to-end streaming. External AI and Tavily requests are **mocked** in these tests; a real end-to-end search requires a working AI connection and Tavily availability. `npm run build` checks the TypeScript app and builds the production bundle.

---

Made for curious builders. **Make room for what’s next.**
