import 'dotenv/config';
import express from 'express';
import { isNonChatModelId } from '../src/lib/model-policy.mjs';
import { timingSafeEqual } from 'node:crypto';
import {
  RequestError, validateChat, buildRequest, friendlyUpstreamError,
  readSSE, readLines, extractChunk, getFreeOpenRouterModels,
  getFreeXkiroModels, getXkiroFreeCatalog, xkiroCatalogIsFresh,
} from './providers.mjs';
import { planWebSearch, searchWeb, withSearchContext } from './search.mjs';
import { createFileOpParser } from './file-ops.mjs';
import { browse, describeBrowse, BrowseError } from './browse.mjs';

const app = express();
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || '';
const accessCode = process.env.AIFLUX_ACCESS_CODE || '';
const envSearchKey = process.env.TAVILY_API_KEY?.trim() || '';
const envKeys = {
  openrouter: process.env.OPENROUTER_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
  xkiro: process.env.XKIRO_API_KEY || '',
};

// Vercel (and any reverse proxy) terminates TLS and forwards the request, so the
// socket address is the proxy's — not the visitor's. Without trusting the proxy
// every visitor collapses into a single rate-limit bucket and one person's
// traffic locks out the whole deployment.
const trustProxy = Boolean(process.env.VERCEL) || process.env.AIFLUX_TRUST_PROXY === '1';
if (trustProxy) app.set('trust proxy', true);

// Vercel ends a function at its maxDuration, which vercel.json sets to 300s —
// the documented maximum on both Hobby and Pro. Stopping a little inside that
// wall lets us tell the client the answer is resumable instead of being killed
// mid-stream with a 504. Lower AIFLUX_REQUEST_TIMEOUT_MS if your project is on
// an older configuration with a smaller ceiling.
const DEFAULT_TIMEOUT_MS = process.env.VERCEL ? 290_000 : 120_000;
const REQUEST_TIMEOUT_MS = Math.max(5_000, Math.min(
  Number(process.env.AIFLUX_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  600_000,
));
// Some proxies and CDNs buffer a response that is silent for too long. Idle
// comment frames keep a slow first token or a search plan from looking dead.
const KEEPALIVE_MS = 5_000;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use('/api', express.json({ limit: '500kb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/config', (_req, res) => {
  res.json({
    configured: Object.fromEntries(Object.entries(envKeys).map(([provider, key]) => [provider, Boolean(key)])),
    ollamaConfigured: Boolean(ollamaBaseUrl),
    searchConfigured: Boolean(envSearchKey),
    requiresAccessCode: Boolean(accessCode),
  });
});

let catalogCache = { at: 0, models: [] };
app.get('/api/models', async (_req, res) => {
  // Run discovery and the local Ollama lookup together: serially they can exceed
  // a serverless function's execution budget.
  const usedLiveDiscovery = Date.now() - catalogCache.at > 10 * 60 * 1000;
  const [discovery, ollama, xkiro] = await Promise.allSettled([
    usedLiveDiscovery ? getFreeOpenRouterModels() : Promise.resolve(catalogCache.models),
    ollamaBaseUrl ? fetchOllamaModels() : Promise.resolve([]),
    xkiroCatalogIsFresh() ? Promise.resolve(getXkiroFreeCatalog()) : getFreeXkiroModels(),
  ]);
  let catalogAvailable = true;
  let models = catalogCache.models;
  if (discovery.status === 'fulfilled') {
    models = discovery.value;
    // Only stamp the cache when discovery actually ran; otherwise a busy
    // workspace would refresh its TTL on every request and never see new models.
    if (usedLiveDiscovery) catalogCache = { at: Date.now(), models };
  } else {
    catalogAvailable = false;
  }
  res.json({
    models,
    ollamaModels: ollama.status === 'fulfilled' ? ollama.value : [],
    xkiroModels: xkiro.status === 'fulfilled' ? xkiro.value : getXkiroFreeCatalog(),
    catalogAvailable,
    xkiroAvailable: xkiro.status === 'fulfilled' || getXkiroFreeCatalog().length > 0,
  });
});

async function fetchOllamaModels() {
  const response = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.models || [])
    .filter((model) => typeof model.name === 'string' && !isNonChatModelId(model.name))
    .slice(0, 80)
    .map((model) => ({
      id: model.name, provider: 'ollama', name: model.name,
      shortName: model.name, description: 'Runs privately on your Ollama server.',
      strength: 'Local & private', badge: 'LOCAL',
    }));
}

const limits = new Map();
/**
 * The visitor identity used for rate limiting. Behind a proxy the socket address
 * is the proxy's, so `trust proxy` must be on for `req.ip` to be the real client.
 */
function clientKey(req) {
  return req.ip || req.get('x-real-ip') || req.socket?.remoteAddress || 'unknown';
}
function rateLimit(req, res, next) {
  const address = clientKey(req);
  const now = Date.now();
  const previous = limits.get(address);
  const window = previous && now - previous.start < 10 * 60_000 ? previous : { start: now, count: 0, searches: 0 };
  window.count += 1;
  limits.set(address, window);
  if (limits.size > 1000) {
    for (const [key, value] of limits) if (now - value.start > 10 * 60_000) limits.delete(key);
  }
  if (window.count > 60) return res.status(429).json({ error: 'Too many requests from this workspace. Please try again in a few minutes.' });
  if (['auto', 'always'].includes(req.body?.searchMode)) {
    window.searches = (window.searches || 0) + 1;
    if (window.searches > 12) return res.status(429).json({ error: 'Too many web searches from this workspace. Try again in a few minutes.' });
  }
  next();
}

function correctAccessCode(candidate) {
  if (!accessCode) return true;
  if (typeof candidate !== 'string') return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(accessCode);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** SSE comment frames: ignored by clients, but they keep the connection warm. */
function startKeepAlive(res) {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function startStream(res, model) {
  if (res.headersSent) return;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sendEvent(res, { type: 'start', model });
}

app.post('/api/chat', rateLimit, async (req, res) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  let stopKeepAlive = null;
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (!correctAccessCode(req.get('x-aiflux-access-code'))) {
      throw new RequestError(403, 'Enter the workspace access code in Settings to continue.');
    }
    const input = validateChat(req.body, Boolean(ollamaBaseUrl));
    const suppliedKey = req.get('x-aiflux-key')?.trim() || '';
    const suppliedSearchKey = req.get('x-aiflux-search-key')?.trim() || '';
    if (suppliedKey.length > 512 || suppliedSearchKey.length > 512) throw new RequestError(400, 'Invalid API key.');
    const key = suppliedKey || envKeys[input.provider] || '';
    // Check the model connection before making any search calls.
    let { url, options, format } = buildRequest(input, key, ollamaBaseUrl);
    if (input.searchMode !== 'off') {
      startStream(res, input.model);
      stopKeepAlive = startKeepAlive(res);
      sendEvent(res, { type: 'search', phase: 'planning' });
      const query = await planWebSearch(input, key, ollamaBaseUrl, { signal: controller.signal });
      if (query) {
        sendEvent(res, { type: 'search', phase: 'searching', query });
        const sources = await searchWeb(query, suppliedSearchKey || envSearchKey, { signal: controller.signal });
        sendEvent(res, { type: 'sources', query, sources });
        ({ url, options, format } = buildRequest(withSearchContext(input, query, sources), key, ollamaBaseUrl));
      } else {
        // The already-built answer request has the full AIFLUX profile plus
        // a mode-specific warning that no live search was performed.
        sendEvent(res, { type: 'search', phase: 'skipped' });
      }
    }
    const upstream = await fetch(url, { ...options, signal: controller.signal });
    if (!upstream.ok) {
      const raw = await upstream.text();
      throw new RequestError(upstream.status >= 500 ? 502 : upstream.status, friendlyUpstreamError(upstream.status, raw, key));
    }
    if (!upstream.body) throw new RequestError(502, 'The provider returned an empty response.');
    startStream(res, input.model);
    stopKeepAlive ??= startKeepAlive(res);
    let usedModel = input.model;
    let hasText = false;
    // Prose reaches the chat as usual; tagged file writes are lifted out of the
    // stream and sent as `file` events so the canvas, not the transcript, holds
    // the code.
    const parser = createFileOpParser({
      onText: (text) => sendEvent(res, { type: 'delta', text }),
      onOp: (op) => sendEvent(res, op.action === 'url_fetch' ? { type: 'browse', ...op } : { type: 'file', ...op }),
    });
    // Replay the block the last attempt was cut off inside, so this stream
    // finishes the very same write rather than opening a second one.
    if (input.resumeBlock) parser.push(input.resumeBlock);
    const chunks = format === 'ollama' ? readLines(upstream.body) : readSSE(upstream.body);
    // `finally` matters: when the request budget aborts the stream, the parser
    // must still flush, or a half-written block is lost and the canvas silently
    // receives nothing.
    try {
      for await (const data of chunks) {
        if (controller.signal.aborted) break;
        const part = extractChunk(format, data);
        if (part.error) {
          const safeMessage = key ? String(part.error).replaceAll(key, '[redacted]') : String(part.error);
          throw new RequestError(502, safeMessage.slice(0, 320));
        }
        // OpenRouter and xKiro are multi-vendor gateways, so a mislabelled route
        // can answer with a safety or utility model. Stop the stream rather than
        // presenting that output as a coding answer.
        if (part.model && (input.provider === 'openrouter' || input.provider === 'xkiro')
            && (part.model === 'openrouter/free' || isNonChatModelId(part.model))) {
          throw new RequestError(502, 'The provider returned a safety or utility model instead of a coding assistant. Choose another free model.');
        }
        if (part.model && part.model !== usedModel) {
          usedModel = part.model;
          sendEvent(res, { type: 'model', model: usedModel });
        }
        if (part.text) {
          if (!hasText && stopKeepAlive) { stopKeepAlive(); stopKeepAlive = null; }
          hasText = true;
          parser.push(part.text);
        }
        if (part.done) break;
      }
    } finally {
      parser.end();
    }
    if (!controller.signal.aborted) {
      if (!hasText) sendEvent(res, { type: 'error', message: 'The model returned no text. Try another model or rephrase your request.' });
      else sendEvent(res, { type: 'done', model: usedModel });
    }
    res.end();
  } catch (error) {
    // Hitting the request budget is not a failure — the model was still writing.
    // Say so distinctly so the client can pick the answer back up instead of
    // showing the partial text as an error.
    if (timedOut) {
      if (!res.headersSent) res.status(504).json({ error: `The request reached the ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s limit before the answer finished.` });
      else { sendEvent(res, { type: 'truncated', reason: 'timeout' }); res.end(); }
      return;
    }
    const message = controller.signal.aborted
      ? 'The provider took too long to respond. Please try again.'
      : error instanceof RequestError ? error.message : 'Could not reach the AI provider. Check your connection and try again.';
    if (!res.headersSent) res.status(error instanceof RequestError ? Math.min(error.status, 599) : 502).json({ error: message });
    else { sendEvent(res, { type: 'error', message }); res.end(); }
  } finally {
    clearTimeout(timeout);
    stopKeepAlive?.();
  }
});

// The model asks for a page with <url_fetch>; this is the other half. It runs on
// the server because a browser cannot read a third-party page, and it is separate
// from /api/chat because one fetch must not hold a whole generation open.
app.post('/api/browse', rateLimit, async (req, res) => {
  try {
    if (!correctAccessCode(req.get('x-aiflux-access-code'))) {
      return res.status(403).json({ error: 'Enter the workspace access code in Settings to continue.' });
    }
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url) return res.status(400).json({ error: 'No URL provided.' });
    if (url.length > 2_000) return res.status(400).json({ error: 'That URL is too long.' });

    // Reaching out to a third party and parsing the answer costs far more than a
    // chat turn, so browsing gets its own tighter allowance inside the window.
    const window = limits.get(clientKey(req));
    window.browses = (window.browses || 0) + 1;
    if (window.browses > 20) {
      return res.status(429).json({ error: 'Too many pages opened from this workspace. Try again in a few minutes.' });
    }

    const result = await browse(url);
    res.json({ ...result, summary: describeBrowse(result) });
  } catch (error) {
    if (error instanceof BrowseError) {
      const status = ['bad_url', 'bad_scheme'].includes(error.code) ? 400 : 422;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    res.status(502).json({ error: 'Could not open that page.' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

export default app;
export { REQUEST_TIMEOUT_MS, clientKey, limits };
