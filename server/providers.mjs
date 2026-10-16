import catalog from '../src/data/models.json' with { type: 'json' };
import { isNonChatModelId, isSelectableOpenRouterId, isUsableFreeCatalogModel } from '../src/lib/model-policy.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';
import { isDesignRequest } from './design-profile.mjs';

// Keep this default export for callers that display the base guidance. Requests
// use buildAssistantPrompt per turn so their features and Web state stay current.
export const SYSTEM_PROMPT = buildAssistantPrompt();

export const PROVIDER_URLS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/',
  xkiro: 'https://api.xkiro.com/v1/chat/completions',
});

// Public and unmetered: returns chat models only unless another modality is asked
// for, and carries the authoritative `access_tier` used for the free-only filter.
const XKIRO_MODELS_URL = 'https://api.xkiro.com/v1/models';
// xKiro model IDs are `vendor/model`. Unlike OpenRouter, free models do not share
// a suffix: some end in `:free`, others do not, so the ID alone cannot tell us
// whether a model is free and we must consult the catalog.
const XKIRO_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._:+@-]{0,80}$/i;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateChat(body, ollamaConfigured = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Invalid request.');
  }
  const { provider, model, messages, searchMode = 'off', canvas, resume } = body;
  if (!['off', 'auto', 'always'].includes(searchMode)) {
    throw new RequestError(400, 'Choose a valid web search mode.');
  }
  if (!['openrouter', 'gemini', 'groq', 'ollama', 'xkiro'].includes(provider)) {
    throw new RequestError(400, 'Choose a supported provider.');
  }
  if (typeof model !== 'string' || model.length > 180) {
    throw new RequestError(400, 'Choose a valid model.');
  }
  if (provider === 'openrouter' && model === 'openrouter/free') {
    throw new RequestError(400, 'The random free router can select safety classifiers. Choose a specific free coding model instead.');
  }
  if (isNonChatModelId(model)) {
    throw new RequestError(400, 'That is a safety or utility model, not a coding assistant. Choose a free chat model instead.');
  }
  if (provider === 'openrouter' && !isSelectableOpenRouterId(model)) {
    throw new RequestError(400, 'Only specific OpenRouter :free chat models are available in AIFLUX.');
  }
  if (['gemini', 'groq'].includes(provider) && !catalog.some((entry) => entry.provider === provider && entry.id === model)) {
    throw new RequestError(400, 'This model is not in the supported free-tier catalog.');
  }
  if (provider === 'xkiro' && !XKIRO_MODEL_ID.test(model)) {
    throw new RequestError(400, 'That is not a valid xKiro model id. Use the vendor/model form, for example qwen/qwen3-coder-plus:free.');
  }
  if (provider === 'xkiro' && !isXkiroModelAvailable(model)) {
    throw new RequestError(400, 'That xKiro model is not currently listed as free. Pick a free model from the model library.');
  }
  if (provider === 'ollama' && (!ollamaConfigured || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model))) {
    throw new RequestError(400, 'Connect Ollama on the server and choose an installed model.');
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) {
    throw new RequestError(400, 'A conversation needs 1–50 messages.');
  }
  let totalLength = 0;
  const cleanMessages = messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) {
      throw new RequestError(400, 'Conversation messages must contain text.');
    }
    totalLength += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalLength > 180_000 || cleanMessages.at(-1).role !== 'user') {
    throw new RequestError(400, 'Conversation is too long or does not end with a user message. Start a new chat or shorten the context.');
  }
  // What is on the Canvas, with contents for whatever fits. Giving the model the
  // current text is what makes SEARCH/REPLACE patches reliable — and it removes
  // the reason agentic models invent a way to fetch the file themselves.
  let contentBudget = 60_000;
  const canvasFiles = Array.isArray(canvas)
    ? canvas.slice(0, 60).map((entry) => {
        const name = typeof entry?.name === 'string' ? entry.name.replace(/[^\w./-]/g, '').slice(0, 100) : '';
        if (!name) return null;
        const lines = Number.isFinite(entry?.lines) ? Math.max(0, Math.trunc(entry.lines)) : 0;
        const raw = typeof entry?.content === 'string' ? entry.content : '';
        const content = raw.slice(0, Math.max(0, Math.min(raw.length, contentBudget)));
        contentBudget -= content.length;
        return { name, lines, content };
      }).filter(Boolean)
    : [];
  // A write the previous attempt ran out of time inside. The server replays it
  // into the parser so the continuation completes the same block instead of
  // starting a new one. Never arbitrary text: it must open a tagged block.
  // Rejected outright if oversized: truncating it would leave the block
  // unterminated and corrupt the file it was meant to complete.
  const resumeBlock = typeof resume === 'string' && resume.length <= 400_000 && /^\s*<aiflux-(write|patch)\b/i.test(resume)
    ? resume
    : '';
  return { provider, model, messages: cleanMessages, searchMode, canvasFiles, resumeBlock };
}

export function buildRequest({ provider, model, messages, searchMode = 'off', searchPerformed = false, systemPrompt, canvasFiles = [], references = '' }, key, ollamaBaseUrl) {
  // Design knowledge is worth its tokens only when the request is design work.
  // Judged on the oldest and newest thing the user asked for: the newest is
  // usually the real question, but after a page is fetched the newest message
  // is the injected result, and dropping the playbook on the turn where the
  // code actually gets written would defeat the point of fetching it.
  const userMessages = messages.filter((message) => message.role === 'user');
  const design = isDesignRequest(userMessages.at(0)?.content) || isDesignRequest(userMessages.at(-1)?.content);
  // References the server fetched for this request are appended last so they
  // arrive after the identity and the protocol, where the model is most likely
  // to treat them as material rather than instructions.
  const base = systemPrompt || buildAssistantPrompt({ provider, model, searchMode, searchPerformed, canvasFiles, design });
  const prompt = references ? `${base}\n\n${references}` : base;
  if (provider !== 'ollama' && !key) {
    throw new RequestError(401, `Connect your ${providerName(provider)} API key in Settings to continue.`);
  }
  if (provider === 'gemini') {
    return {
      url: `${PROVIDER_URLS.gemini}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      format: 'gemini',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: messages.map(({ role, content }) => ({
            role: role === 'assistant' ? 'model' : 'user',
            parts: [{ text: content }],
          })),
        }),
      },
    };
  }
  if (provider === 'ollama') {
    return {
      url: `${ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`,
      format: 'ollama',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: prompt }, ...messages],
          stream: true,
        }),
      },
    };
  }
  return {
    url: PROVIDER_URLS[provider],
    format: 'openai',
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(provider === 'openrouter' ? { 'X-Title': 'AIFLUX' } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: prompt }, ...messages],
        stream: true,
      }),
    },
  };
}

function providerName(provider) {
  return ({ openrouter: 'OpenRouter', gemini: 'Gemini', groq: 'Groq', xkiro: 'xKiro', ollama: 'Ollama' })[provider] ?? provider;
}

export function friendlyUpstreamError(status, raw, key = '') {
  let message = '';
  try {
    const parsed = JSON.parse(raw);
    message = parsed.error?.message || parsed.message || '';
  } catch {
    // Upstream sometimes returns an HTML error page. Do not reflect it into the UI.
  }
  if (typeof message !== 'string') message = '';
  if (key) message = message.replaceAll(key, '[redacted]');
  message = message.slice(0, 320);
  if (status === 401 || status === 403) return `The provider rejected this API key or account access.${message ? ` ${message}` : ''}`;
  if (status === 429) return `The provider's free-tier limit was reached. Try again later or switch models.${message ? ` ${message}` : ''}`;
  return message || `The AI provider returned an error (${status}). Try another model or check your connection.`;
}

// Both OpenAI-compatible providers and Gemini send Server-Sent Events.
// This parser handles chunks split anywhere, multi-line data, and CRLF.
export async function* readSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const data = buffer.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

export async function* readLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

export function extractChunk(format, data) {
  if (data === '[DONE]') return { done: true };
  let parsed;
  try { parsed = JSON.parse(data); } catch { return {}; }
  if (parsed.error) {
    return { error: typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'The provider could not complete this request.' };
  }
  if (format === 'gemini') {
    const parts = parsed.candidates?.[0]?.content?.parts || [];
    return { text: parts.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('') };
  }
  if (format === 'ollama') {
    return { text: parsed.message?.content || '', done: parsed.done === true, model: parsed.model };
  }
  const content = parsed.choices?.[0]?.delta?.content;
  return {
    text: typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text || '').join('') : '',
    model: parsed.model,
  };
}

// xKiro's free status lives in `access_tier`, not in the model id, so the live
// catalogue is cached here rather than in api-app.mjs: request validation needs
// it to keep paid models out of a workspace that advertises free models only.
const XKIRO_CACHE_TTL = 10 * 60 * 1000;
let xkiroCache = { at: 0, models: [] };

/** Free xKiro models from the last successful discovery (empty if unavailable). */
export function getXkiroFreeCatalog() {
  return xkiroCache.models;
}

/**
 * Whether a model may be sent to xKiro. Curated picks always pass. When live
 * discovery has worked, only models it listed as free pass. If discovery has
 * never succeeded we fall back to the id format check already applied, and say
 * so in the UI rather than silently allowing any paid model through.
 */
export function isXkiroModelAvailable(model) {
  if (catalog.some((entry) => entry.provider === 'xkiro' && entry.id === model)) return true;
  if (xkiroCache.models.length) return xkiroCache.models.some((entry) => entry.id === model);
  return true;
}

export async function getFreeXkiroModels(fetchImpl = fetch) {
  const response = await fetchImpl(XKIRO_MODELS_URL, { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('xKiro model catalog unavailable');
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('Invalid xKiro model catalog');
  const featured = new Set(catalog.filter((entry) => entry.provider === 'xkiro').map((entry) => entry.id));
  const models = json.data
    // The endpoint returns chat models by default, but stay defensive: a
    // moderation, embedding or safety endpoint must never reach the composer.
    .filter((model) => model && typeof model.id === 'string' && model.access_tier === 'free'
      && !isNonChatModelId(model.id) && !isNonChatModelId(model.display_name || ''))
    .map((model) => ({
      id: model.id,
      provider: 'xkiro',
      name: String(model.display_name || model.id).replace(/\s*\(free\)\s*$/i, '').slice(0, 80),
      shortName: String(model.id).split('/').at(-1)?.replace(/:free$/, '').slice(0, 36) || String(model.id).slice(0, 36),
      description: describeXkiroModel(model),
      strength: /coder|coding|code|devstral|software.engineer/i.test(`${model.id} ${model.display_name || ''}`) ? 'Coding focused' : 'Free on xKiro',
      badge: 'FREE MODEL',
      contextLength: Number(model.context_length) || undefined,
    }))
    .sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)) ||
      Number(b.strength === 'Coding focused') - Number(a.strength === 'Coding focused') || a.name.localeCompare(b.name))
    .slice(0, 100);
  xkiroCache = { at: Date.now(), models };
  return models;
}

export function xkiroCatalogIsFresh() {
  return xkiroCache.models.length > 0 && Date.now() - xkiroCache.at < XKIRO_CACHE_TTL;
}

function describeXkiroModel(model) {
  const parts = [];
  if (Number(model.context_length)) parts.push(`${formatContext(Number(model.context_length))} context`);
  const capabilities = model.capabilities || {};
  const flags = ['vision', 'tools', 'reasoning'].filter((key) => capabilities[key]);
  if (flags.length) parts.push(flags.join(', '));
  const vendor = model.owned_by || String(model.id).split('/')[0];
  return `Free on xKiro${parts.length ? ` · ${parts.join(' · ')}` : ''}. Served by ${vendor}.`;
}

function formatContext(tokens) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export async function getFreeOpenRouterModels(fetchImpl = fetch) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('Model catalog unavailable');
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('Invalid model catalog');
  const featured = new Set(catalog.filter((entry) => entry.provider === 'openrouter').map((entry) => entry.id));
  return json.data
    .filter(isUsableFreeCatalogModel)
    .map((model) => ({
      id: model.id,
      provider: 'openrouter',
      name: String(model.name || model.id).replace(/\s*\(free\)\s*$/i, '').slice(0, 80),
      shortName: String(model.name || model.id).replace(/\s*\(free\)\s*$/i, '').slice(0, 36),
      description: String(model.description || 'A currently available free model on OpenRouter.').slice(0, 200),
      // Descriptions can mention coding negatively ("not suited for coding").
      // Only label a model coding-focused when its actual ID or name says so.
      strength: /coder|coding|code|software.engineer|devstral|laguna|\bswe\b/i.test(`${model.id} ${model.name}`) ? 'Coding focused' : 'OpenRouter free',
      badge: 'FREE MODEL',
      contextLength: Number(model.context_length) || undefined,
    }))
    .sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)) ||
      Number(b.strength === 'Coding focused') - Number(a.strength === 'Coding focused') || a.name.localeCompare(b.name))
    .slice(0, 100);
}
