import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  RequestError, validateChat, buildRequest, friendlyUpstreamError,
  readSSE, readLines, extractChunk, getFreeOpenRouterModels,
} from './providers.mjs';

const app = express();
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || '';
const accessCode = process.env.AIFLUX_ACCESS_CODE || '';
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
    requiresAccessCode: Boolean(accessCode),
  });
});

let catalogCache = { at: 0, models: [] };
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
  let ollamaModels = [];
  if (ollamaBaseUrl) {
    try {
      const response = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = await response.json();
        ollamaModels = (data.models || []).filter((model) => typeof model.name === 'string').slice(0, 80).map((model) => ({
          id: model.name, provider: 'ollama', name: model.name,
          shortName: model.name, description: 'Runs privately on your Ollama server.',
          strength: 'Local & private', badge: 'LOCAL',
        }));
      }
    } catch { /* Ollama may not be running yet. */ }
  }
  res.json({ models, ollamaModels, catalogAvailable });
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

app.post('/api/chat', rateLimit, async (req, res) => {
  let timeout;
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (!correctAccessCode(req.get('x-aiflux-access-code'))) {
      throw new RequestError(403, 'Enter the workspace access code in Settings to continue.');
    }
    const input = validateChat(req.body, Boolean(ollamaBaseUrl));
    const suppliedKey = req.get('x-aiflux-key')?.trim() || '';
    if (suppliedKey.length > 512) throw new RequestError(400, 'Invalid API key.');
    const key = suppliedKey || envKeys[input.provider] || '';
    const { url, options, format } = buildRequest(input, key, ollamaBaseUrl);
    timeout = setTimeout(() => controller.abort(new Error('timeout')), 120_000);
    const upstream = await fetch(url, { ...options, signal: controller.signal });
    if (!upstream.ok) {
      const raw = await upstream.text();
      throw new RequestError(upstream.status >= 500 ? 502 : upstream.status, friendlyUpstreamError(upstream.status, raw, key));
    }
    if (!upstream.body) throw new RequestError(502, 'The provider returned an empty response.');
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    sendEvent(res, { type: 'start', model: input.model });
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
