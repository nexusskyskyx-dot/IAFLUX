import 'dotenv/config';
import express from 'express';
import catalog from '../src/data/models.json' with { type: 'json' };
import { isNonChatModelId } from '../src/lib/model-policy.mjs';
import { timingSafeEqual } from 'node:crypto';
import {
  RequestError, validateChat, buildRequest, friendlyUpstreamError,
  readSSE, readLines, extractChunk, getFreeOpenRouterModels,
} from './providers.mjs';
import { planWebSearch, searchWeb, withSearchContext } from './search.mjs';
import { listAIFluxModels, memberInfo, resolveAIFluxRoute } from './aiflux-family.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';

const app = express();
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || '';
const accessCode = process.env.AIFLUX_ACCESS_CODE || '';
const envSearchKey = process.env.TAVILY_API_KEY?.trim() || '';
const envKeys = {
  openrouter: process.env.OPENROUTER_API_KEY || '',
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

app.get('/api/config', (_req, res) => {
  res.json({
    configured: Object.fromEntries(Object.entries(envKeys).map(([provider, key]) => [provider, Boolean(key)])),
    ollamaConfigured: Boolean(ollamaBaseUrl),
    searchConfigured: Boolean(envSearchKey),
    requiresAccessCode: Boolean(accessCode),
    aifluxAvailable: Object.values(envKeys).some((k) => Boolean(k)),
  });
});

// Seed cache with the curated static catalog so that /api/models always returns
// a useful list even before the live OpenRouter fetch succeeds (sandbox/offline).
let catalogCache = { at: 0, models: catalog };
app.get('/api/models', async (_req, res) => {
  let models = catalogCache.models;
  let catalogAvailable = true;
  if (Date.now() - catalogCache.at > 10 * 60 * 1000) {
    try {
      models = await getFreeOpenRouterModels();
      catalogCache = { at: Date.now(), models };
    } catch {
      catalogAvailable = false;
      models = catalogCache.models;
    }
  }
  // Always present the AIFLUX family models at the TOP of the catalog, before
  // provider-specific entries. These are routed server-side to the best
  // available free model for each persona.
  const aifluxModels = listAIFluxModels().map(({ _meta, ...rest }) => rest);
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
  res.json({ models: [...aifluxModels, ...models], ollamaModels, catalogAvailable });
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
    const searchHeader = req.get('x-aiflux-search-key')?.trim() || '';
    const keysHeader = req.get('x-aiflux-keys') || '';
    let userKeys = { openrouter: '', gemini: '', groq: '' };
    try {
      if (keysHeader) {
        const parsed = JSON.parse(decodeURIComponent(keysHeader));
        if (parsed && typeof parsed === 'object') {
          userKeys = {
            openrouter: typeof parsed.openrouter === 'string' ? parsed.openrouter.slice(0, 512) : '',
            gemini: typeof parsed.gemini === 'string' ? parsed.gemini.slice(0, 512) : '',
            groq: typeof parsed.groq === 'string' ? parsed.groq.slice(0, 512) : '',
          };
        }
      }
    } catch {
      throw new RequestError(400, 'Invalid API key header.');
    }
    if (searchHeader.length > 512) throw new RequestError(400, 'Invalid API key.');
    const input = validateChat(req.body, Boolean(ollamaBaseUrl), (memberId) => {
      return resolveAIFluxRoute(memberId, userKeys, envKeys, Boolean(ollamaBaseUrl));
    });
    const suppliedSearchKey = searchHeader;
    const selectedProvider = input.provider;
    const key = (userKeys[selectedProvider] || envKeys[selectedProvider] || '');
    // AIFLUX persona system prompt: append the member addendum onto the base
    // AIFLUX identity prompt, and force searchMode=auto for Toki.
    const personaSystemPrompt = input.aifluxRoute
      ? buildAssistantPrompt({ provider: input.provider, model: input.model, searchMode: input.searchMode }) + `\n\n${input.aifluxRoute.memberAddendum}`
      : undefined;
    // Check the model connection before making any search calls.
    let { url, options, format } = buildRequest({ ...input, systemPrompt: personaSystemPrompt }, key, ollamaBaseUrl);
    timeout = setTimeout(() => controller.abort(new Error('timeout')), 120_000);
    if (input.searchMode !== 'off') {
      startStream(res, input.model);
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
    let usedModel = input.model;
    let hasText = false;
    let rawText = '';
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
        rawText += part.text;
        hasText = true;
        sendEvent(res, { type: 'delta', text: part.text });
      }
      if (part.done) break;
    }
    if (!controller.signal.aborted) {
      // Some providers stream whitespace-only chunks or emit only tool-call XML
      // from the client-side tool system. Treat non-empty raw text that strips
      // to nothing after whitespace/tool removal as a valid (empty-prose) turn
      // rather than a hard error — the client will surface tool activity.
      const stripped = rawText.replace(/<af-tool\b[^>]*>[\s\S]*?<\/af-tool>/g, '').trim();
      if (!hasText || (!stripped && rawText.trim().length === 0)) {
        sendEvent(res, { type: 'error', message: 'The model returned no text. Try another model or rephrase your request.' });
      } else {
        sendEvent(res, { type: 'done', model: usedModel });
      }
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
