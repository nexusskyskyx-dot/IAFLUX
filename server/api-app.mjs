import 'dotenv/config';
import express from 'express';
import { isNonChatModelId } from '../src/lib/model-policy.mjs';
import { timingSafeEqual } from 'node:crypto';
import {
  RequestError, validateChat, buildRequest, friendlyUpstreamError,
  readSSE, readLines, extractChunk, getFreeOpenRouterModels, getFreeXkiroModels,
  getGeminiModels, getGroqModels,
} from './providers.mjs';
import { planWebSearch, searchWeb, withSearchContext } from './search.mjs';
import { createGitHubRouter } from './github.mjs';

const app = express();
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || '';
const accessCode = process.env.AIFLUX_ACCESS_CODE || '';
const envSearchKey = process.env.TAVILY_API_KEY?.trim() || '';
const envKeys = {
  openrouter: process.env.OPENROUTER_API_KEY || '',
  xkiro: process.env.XKIRO_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
};

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
app.use('/api/github', createGitHubRouter());

app.get('/api/config', (_req, res) => {
  res.json({
    configured: Object.fromEntries(Object.entries(envKeys).map(([provider, key]) => [provider, Boolean(key)])),
    ollamaConfigured: Boolean(ollamaBaseUrl),
    searchConfigured: Boolean(envSearchKey),
    requiresAccessCode: Boolean(accessCode),
  });
});

const CATALOG_CACHE_TTL = 10 * 60 * 1000;
const XKIRO_CATALOG_CACHE_TTL = 60 * 1000;
const catalogCache = {
  openrouter: { at: 0, models: [] },
  xkiro: { at: 0, models: [] },
};

async function getCachedModels(cache, load, failClosed = false, ttl = CATALOG_CACHE_TTL) {
  if (Date.now() - cache.at <= ttl) return { models: cache.models, available: true };
  try {
    const models = await load();
    cache.at = Date.now();
    cache.models = models;
    return { models, available: true };
  } catch {
    // Keep OpenRouter's existing stale-list fallback, but never authorize xKiro against stale pricing.
    return { models: failClosed ? [] : cache.models, available: false };
  }
}

app.get('/api/models', async (_req, res) => {
  const [openrouterCatalog, xkiroCatalog] = await Promise.all([
    getCachedModels(catalogCache.openrouter, getFreeOpenRouterModels),
    getCachedModels(catalogCache.xkiro, getFreeXkiroModels, true, XKIRO_CATALOG_CACHE_TTL),
  ]);
  const { models, available: catalogAvailable } = openrouterCatalog;
  const xkiroModels = xkiroCatalog.models;
  let ollamaModels = [];
  if (ollamaBaseUrl) {
    try {
      const response = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = await response.json();
        ollamaModels = (data.models || []).filter((model) => typeof model.name === 'string' && !isNonChatModelId(model.name)).slice(0, 80).map((model) => ({
          id: model.name, provider: 'ollama', name: model.name,
          shortName: model.name, description: 'Runs privately on your Ollama server.',
          strength: 'Local & private', badge: 'LOCAL',
        }));
      }
    } catch { /* Ollama may not be running yet. */ }
  }
  res.json({ models, xkiroModels, ollamaModels, catalogAvailable, xkiroCatalogAvailable: xkiroCatalog.available });
});

const discoveryLimits = new Map();
app.post('/api/models/discover', async (req, res) => {
  const { provider } = req.body || {};
  if (!['gemini', 'groq'].includes(provider)) return res.status(400).json({ error: 'Choose Gemini or Groq model discovery.' });
  const suppliedKey = typeof req.body.key === 'string' ? req.body.key.trim() : '';
  if (suppliedKey.length > 500) return res.status(400).json({ error: 'The provider key is too long.' });
  const key = suppliedKey || envKeys[provider];
  if (!key) return res.status(401).json({ error: `Connect your ${provider === 'gemini' ? 'Gemini' : 'Groq'} API key to discover models.` });
  const address = req.ip || 'unknown';
  const now = Date.now();
  const previous = discoveryLimits.get(address);
  const window = previous && now - previous.start < 10 * 60_000 ? previous : { start: now, count: 0 };
  window.count += 1;
  discoveryLimits.set(address, window);
  if (discoveryLimits.size > 1000) {
    for (const [ip, value] of discoveryLimits) if (now - value.start > 10 * 60_000) discoveryLimits.delete(ip);
  }
  if (window.count > 20) return res.status(429).json({ error: 'Too many model discovery requests. Try again in a few minutes.' });
  try {
    const discoveryOptions = { includeUncurated: Boolean(suppliedKey) };
    const models = provider === 'gemini'
      ? await getGeminiModels(key, fetch, discoveryOptions)
      : await getGroqModels(key, fetch, discoveryOptions);
    return res.json({ provider, models });
  } catch (error) {
    return res.status(error instanceof RequestError ? Math.min(error.status, 599) : 502)
      .json({ error: error instanceof RequestError ? error.message : 'Could not discover provider models. Try again.' });
  }
});

const limits = new Map();
function rateLimit(req, res, next) {
  const address = req.ip || 'unknown';
  const now = Date.now();
  const previous = limits.get(address);
  const window = previous && now - previous.start < 10 * 60_000 ? previous : { start: now, count: 0 };
  window.count += 1;
  limits.set(address, window);
  if (limits.size > 1000) {
    for (const [key, value] of limits) if (now - value.start > 10 * 60_000) limits.delete(key);
  }
  if (window.count > 60) return res.status(429).json({ error: 'Too many requests from this workspace. Please try again in a few minutes.' });
  next();
}

function recordWebSearch(req) {
  const window = limits.get(req.ip || 'unknown');
  if (!window) return;
  window.searches = (window.searches || 0) + 1;
  if (window.searches > 12) throw new RequestError(429, 'Too many live web searches from this workspace. Try again in a few minutes.');
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
  let timeout;
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (!correctAccessCode(req.get('x-aiflux-access-code'))) {
      throw new RequestError(403, 'Enter the workspace access code in Settings to continue.');
    }
    let xkiroFreeModelIds;
    if (req.body?.provider === 'xkiro') {
      const xkiroCatalog = await getCachedModels(catalogCache.xkiro, getFreeXkiroModels, true, XKIRO_CATALOG_CACHE_TTL);
      if (!xkiroCatalog.available) {
        throw new RequestError(503, 'The xKiro free-model catalog is temporarily unavailable, so AIFLUX cannot verify free access. Refresh the model list or use another provider.');
      }
      xkiroFreeModelIds = new Set(xkiroCatalog.models.map((model) => model.id));
    }
    const suppliedKey = req.get('x-aiflux-key')?.trim() || '';
    const suppliedSearchKey = req.get('x-aiflux-search-key')?.trim() || '';
    if (suppliedKey.length > 512 || suppliedSearchKey.length > 512) throw new RequestError(400, 'Invalid API key.');
    const input = validateChat(req.body, Boolean(ollamaBaseUrl), xkiroFreeModelIds, Boolean(suppliedKey));
    const key = suppliedKey || envKeys[input.provider] || '';
    // Check the model connection before making any search calls.
    let { url, options, format } = buildRequest(input, key, ollamaBaseUrl);
    timeout = setTimeout(() => controller.abort(new Error('timeout')), 120_000);
    if (input.searchMode !== 'off') {
      startStream(res, input.model);
      sendEvent(res, { type: 'search', phase: 'planning' });
      const query = await planWebSearch(input, key, ollamaBaseUrl, { signal: controller.signal });
      if (query) {
        recordWebSearch(req);
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
    let usedModel = input.model;
    let hasText = false;
    const chunks = format === 'ollama' ? readLines(upstream.body) : readSSE(upstream.body);
    for await (const data of chunks) {
      if (controller.signal.aborted) break;
      const part = extractChunk(format, data);
      if (part.error) {
        const safeMessage = key ? String(part.error).replaceAll(key, '[redacted]') : String(part.error);
        throw new RequestError(502, safeMessage.slice(0, 320));
      }
      if (input.provider === 'openrouter' && part.model &&
          (part.model === 'openrouter/free' || isNonChatModelId(part.model))) {
        throw new RequestError(502, 'OpenRouter returned a safety or utility model instead of a coding assistant. Choose another free model.');
      }
      if (part.model && part.model !== usedModel) {
        usedModel = part.model;
        sendEvent(res, { type: 'model', model: usedModel });
      }
      if (part.text) {
        hasText = true;
        sendEvent(res, { type: 'delta', text: part.text });
      }
      if (part.done) break;
    }
    if (!controller.signal.aborted) {
      if (!hasText) sendEvent(res, { type: 'error', message: 'The model returned no text. Try another model or rephrase your request.' });
      else sendEvent(res, { type: 'done', model: usedModel });
    }
    res.end();
  } catch (error) {
    const message = controller.signal.aborted
      ? 'The provider took too long to respond. Please try again.'
      : error instanceof RequestError ? error.message : 'Could not reach the AI provider. Check your connection and try again.';
    if (!res.headersSent) res.status(error instanceof RequestError ? Math.min(error.status, 599) : 502).json({ error: message });
    else { sendEvent(res, { type: 'error', message }); res.end(); }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

export default app;
