import catalog from '../src/data/models.json' with { type: 'json' };
import { isNonChatModelId, isSelectableOpenRouterId, isUsableFreeCatalogModel } from '../src/lib/model-policy.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';

// Keep this default export for callers that display the base guidance. Requests
// use buildAssistantPrompt per turn so their features and Web state stay current.
export const SYSTEM_PROMPT = buildAssistantPrompt();

export const PROVIDER_URLS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  xkiro: 'https://api.xkiro.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/',
});

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateChat(body, ollamaConfigured = false, xkiroFreeModelIds = new Set(), allowUserKeyModels = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Invalid request.');
  }
  const { provider, model, messages, searchMode = 'off' } = body;
  if (!['off', 'auto', 'always'].includes(searchMode)) {
    throw new RequestError(400, 'Choose a valid web search mode.');
  }
  if (!['openrouter', 'xkiro', 'gemini', 'groq', 'ollama'].includes(provider)) {
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
  if (provider === 'xkiro' && !(xkiroFreeModelIds instanceof Set && xkiroFreeModelIds.has(model))) {
    throw new RequestError(400, 'Choose a model currently listed as free in xKiro’s live chat catalog.');
  }
  if (['gemini', 'groq'].includes(provider) && !catalog.some((entry) => entry.provider === provider && entry.id === model) &&
      !(allowUserKeyModels && /^[a-zA-Z0-9._:/-]{1,180}$/.test(model))) {
    throw new RequestError(400, 'Choose a model from the provider catalog discovered for your API key.');
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
  return { provider, model, messages: cleanMessages, searchMode };
}

export function buildRequest({ provider, model, messages, searchMode = 'off', searchPerformed = false, systemPrompt }, key, ollamaBaseUrl) {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const prompt = systemPrompt || buildAssistantPrompt({ provider, model, searchMode, searchPerformed, latestUserMessage });
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
  return ({ openrouter: 'OpenRouter', xkiro: 'xKiro', gemini: 'Gemini', groq: 'Groq' })[provider] ?? provider;
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

const XKIRO_MODEL_ID = /^[a-zA-Z0-9._:/-]{1,180}$/;

function hasZeroPrice(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount === 0;
}

/** xKiro's public catalog is the source of truth: free chat tier and zero token prices. */
export function isUsableFreeXkiroModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (typeof model.id !== 'string' || !XKIRO_MODEL_ID.test(model.id) || isNonChatModelId(model.id)) return false;
  const displayName = typeof model.display_name === 'string' ? model.display_name : '';
  if (displayName && isNonChatModelId(displayName)) return false;
  const pricing = model.pricing || {};
  const cachePricesAreFree = ['cache_read', 'cache_write'].every((field) => pricing[field] == null || hasZeroPrice(pricing[field]));
  return model.modality === 'chat' && model.access_tier === 'free' &&
    hasZeroPrice(pricing.input) && hasZeroPrice(pricing.output) && cachePricesAreFree;
}

export async function getFreeXkiroModels(fetchImpl = fetch) {
  const response = await fetchImpl('https://api.xkiro.com/v1/models', { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('xKiro model catalog unavailable');
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('Invalid xKiro model catalog');
  return json.data
    .filter(isUsableFreeXkiroModel)
    .map((model) => {
      const name = String(model.display_name || model.id).slice(0, 80);
      const capabilities = model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
      const coding = /coder|coding|\bcode\b|devstral|codestral|software.engineer|\bswe\b/i.test(`${model.id} ${name}`);
      const details = [
        'Daily free-token allowance applies.',
        capabilities.vision ? 'Vision' : '',
        capabilities.tools ? 'Tool calling' : '',
      ].filter(Boolean).join(' · ');
      return {
        id: model.id,
        provider: 'xkiro',
        name,
        shortName: name.slice(0, 36),
        description: `Free xKiro chat model. ${details}`,
        strength: coding ? 'Coding focused' : capabilities.reasoning ? 'Reasoning capable' : capabilities.vision ? 'Vision capable' : 'General chat',
        badge: 'FREE MODEL',
        contextLength: Number(model.context_length) || undefined,
      };
    })
    .sort((a, b) => Number(b.strength === 'Coding focused') - Number(a.strength === 'Coding focused') || a.name.localeCompare(b.name));
}

const DISCOVERED_MODEL_ID = /^[a-zA-Z0-9._:/-]{1,180}$/;

function discoveredModel(provider, id, displayName, description, contextLength, includeUncurated = true) {
  if (!DISCOVERED_MODEL_ID.test(id) || isNonChatModelId(id)) return null;
  const curatedModel = catalog.find((model) => model.provider === provider && model.id === id);
  if (!includeUncurated && !curatedModel) return null;
  const name = String(displayName || id).slice(0, 100);
  const strength = curatedModel?.strength || (/coder|coding|code|software.engineer|devstral|swe/i.test(`${id} ${name}`) ? 'Coding focused' : 'Available model');
  return {
    id,
    provider,
    name,
    shortName: String(curatedModel?.shortName || name).slice(0, 36),
    description: curatedModel?.description || `${String(description || 'Discovered from your provider key.').slice(0, 160)} Check provider pricing and account limits before selecting; usage may incur charges.`,
    strength,
    badge: curatedModel?.badge || 'CHECK PRICING',
    contextLength: Number(contextLength) || curatedModel?.contextLength,
  };
}

export async function getGeminiModels(key, fetchImpl = fetch, { includeUncurated = true } = {}) {
  if (typeof key !== 'string' || !key.trim() || key.length > 500) throw new RequestError(400, 'Enter a valid Gemini API key to discover models.');
  const discovered = new Map();
  let pageToken = '';
  for (let page = 0; page < 5; page += 1) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let response;
    try {
      response = await fetchImpl(url, { headers: { 'x-goog-api-key': key.trim() }, signal: AbortSignal.timeout(9000) });
    } catch { throw new RequestError(502, 'Could not reach Google Gemini model discovery. Try again.'); }
    if (!response.ok) throw new RequestError(response.status === 401 || response.status === 403 ? 401 : 502, 'Gemini model discovery failed. Check the API key and try again.');
    const json = await response.json().catch(() => ({}));
    if (!Array.isArray(json.models)) throw new RequestError(502, 'Gemini returned an invalid model catalog.');
    for (const model of json.models) {
      const fullName = typeof model.name === 'string' ? model.name : '';
      const id = fullName.replace(/^models\//, '');
      const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
      if (!methods.some((method) => ['generateContent', 'streamGenerateContent'].includes(method))) continue;
      const result = discoveredModel('gemini', id, model.displayName, model.description, model.inputTokenLimit, includeUncurated);
      if (result) discovered.set(result.id, result);
    }
    pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
    if (!pageToken) break;
  }
  return [...discovered.values()].sort((a, b) =>
    Number(a.badge === 'CHECK PRICING') - Number(b.badge === 'CHECK PRICING') ||
    Number(b.badge.startsWith('BEST')) - Number(a.badge.startsWith('BEST')) ||
    Number(b.strength === 'Coding focused') - Number(a.strength === 'Coding focused') || a.name.localeCompare(b.name));
}

export async function getGroqModels(key, fetchImpl = fetch, { includeUncurated = true } = {}) {
  if (typeof key !== 'string' || !key.trim() || key.length > 500) throw new RequestError(400, 'Enter a valid Groq API key to discover models.');
  let response;
  try {
    response = await fetchImpl('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(9000),
    });
  } catch { throw new RequestError(502, 'Could not reach Groq model discovery. Try again.'); }
  if (!response.ok) throw new RequestError(response.status === 401 || response.status === 403 ? 401 : 502, 'Groq model discovery failed. Check the API key and try again.');
  const json = await response.json().catch(() => ({}));
  if (!Array.isArray(json.data)) throw new RequestError(502, 'Groq returned an invalid model catalog.');
  const discovered = new Map();
  for (const model of json.data) {
    if (model.active === false || model.status === 'inactive' || typeof model.id !== 'string') continue;
    const result = discoveredModel('groq', model.id, model.name || model.id, model.description, model.context_window || model.context_length, includeUncurated);
    if (result) discovered.set(result.id, result);
  }
  return [...discovered.values()].sort((a, b) =>
    Number(a.badge === 'CHECK PRICING') - Number(b.badge === 'CHECK PRICING') ||
    Number(b.badge.startsWith('BEST')) - Number(a.badge.startsWith('BEST')) ||
    Number(b.strength === 'Coding focused') - Number(a.strength === 'Coding focused') || a.name.localeCompare(b.name));
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
