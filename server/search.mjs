import { buildRequest, friendlyUpstreamError, RequestError } from './providers.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';
import { isNonChatModelId } from '../src/lib/model-policy.mjs';

const SEARCH_URL = 'https://api.tavily.com/search';

/**
 * x-web: one search API over Tavily, Brave Search, Serper and Exa.
 *
 * Set XWEB_BASE to a deployment (see github.com/nexusskyskyx-dot/x-web) and
 * searches go through it instead of straight to one provider. The key the user
 * already keeps in Settings is a provider key, and x-web takes exactly that in
 * X-XWeb-Key, so nothing has to be re-plumbed: the same key buys four indexes
 * and a blended, deduplicated result set instead of one.
 *
 * XWEB_KEY is for a deployment where the provider key lives on the server, or
 * for an x-web account key, so a search can run with nothing in Settings.
 */
const XWEB_BASE = (process.env.XWEB_BASE || '').replace(/\/$/, '');
const XWEB_KEY = process.env.XWEB_KEY || '';

/** Where search goes, for the Settings screen. Nothing here is a secret. */
export const searchBackend = Object.freeze({
  /** 'x-web' when a deployment is configured, otherwise 'tavily'. */
  kind: XWEB_BASE ? 'x-web' : 'tavily',
  /** True when a key lives on the server, so search runs with nothing in Settings. */
  hasServerKey: Boolean(XWEB_KEY),
});

/** The x-web error envelope, so a refusal can be reported in the user's words. */
function xWebMessage(status, body) {
  const detail = body?.error?.message ? ` ${body.error.message}` : '';
  if (status === 401 || status === 403) return `The search key was rejected.${detail} Update it in Settings or clear it.`;
  if (status === 429) return `Web search reached a rate limit.${detail} Try later.`;
  if (status === 402) return `The search provider is out of credit.${detail}`;
  return `The web search service is unavailable.${detail}`;
}
const TOOL_DESCRIPTION = 'Search the live web for current information, official documentation, releases, or recent events. Use a short, general query without private code, credentials, or personal details.';
const TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A concise web search query, at most 180 characters.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

// Keep the search policy available here for existing integrations; the full
// assistant identity and capabilities live in assistant-profile.mjs.
export { SEARCH_SYSTEM_NOTE } from './assistant-profile.mjs';

function latestQuestion(input) {
  // File attachments appended by the client can contain proprietary code.
  const content = input.messages.at(-1)?.content || '';
  return content.split(/\n\nAttached file:/i)[0].replace(/```[\s\S]*?```/g, '[code omitted]').trim().slice(0, 900);
}

export function normalizeSearchQuery(value) {
  if (typeof value !== 'string') return null;
  const query = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length < 3 || query.length > 180) return null;
  // This is a guardrail, not a guarantee that a query contains no private data.
  if (/\b(?:sk-[\w-]{10,}|tvly-[\w-]{8,}|gh[pousr]_[\w-]{12,}|AKIA[0-9A-Z]{16}|AIza[\w-]{20,}|Bearer\s+\S+|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(query)) return null;
  return query;
}

export function likelyNeedsSearch(question) {
  return /\b(?:search|look up|find online|browse|web|internet|today|tonight|yesterday|tomorrow|latest|recent|current|right now|this week|this month|news|weather|price|release|updated|up.to.date|as of|202[5-9])\b/i.test(question);
}

export function buildSearchPlanRequest(input, key, ollamaBaseUrl, now = new Date()) {
  const prompt = `Today is ${now.toISOString().slice(0, 10)} UTC. Decide if a live web search would materially improve the answer to the user request below. Call web_search once with a focused query if current facts, documentation, releases, availability, or events matter. Otherwise reply exactly NO_SEARCH. Never include private code, credentials, file contents, or personal details in the query. Do not answer the user yet.\n\nUser request: ${JSON.stringify(latestQuestion(input))}`;
  const plan = buildRequest({ ...input, messages: [{ role: 'user', content: prompt }], systemPrompt: 'You are AIFLUX, acting as its internal web search planner (not the user-facing answer). Either call web_search once or reply NO_SEARCH. Do not answer the user request.' }, key, ollamaBaseUrl);
  const body = JSON.parse(plan.options.body);
  if (input.provider === 'gemini') {
    body.tools = [{ functionDeclarations: [{
      name: 'web_search', description: TOOL_DESCRIPTION,
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A concise search query.' } }, required: ['query'] },
    }] }];
    return { ...plan, url: plan.url.replace(':streamGenerateContent?alt=sse', ':generateContent'), options: { ...plan.options, body: JSON.stringify(body) } };
  }
  body.stream = false;
  body.tools = [TOOL];
  if (input.provider !== 'ollama') body.tool_choice = 'auto';
  return { ...plan, options: { ...plan.options, body: JSON.stringify(body) } };
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Returns a query, null for an explicit opt-out, or undefined for an unreadable response.
export function parseSearchDecision(provider, payload) {
  const message = provider === 'gemini' ? payload?.candidates?.[0]?.content : provider === 'ollama' ? payload?.message : payload?.choices?.[0]?.message;
  const calls = provider === 'gemini'
    ? message?.parts?.map((part) => part.functionCall).filter(Boolean)
    : message?.tool_calls?.map((call) => call.function).filter(Boolean);
  const call = calls?.find((item) => item.name === 'web_search');
  if (call) return parseArgs(provider === 'gemini' ? call.args : call.arguments)?.query;
  const text = provider === 'gemini'
    ? message?.parts?.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('')
    : message?.content;
  if (typeof text !== 'string') return undefined;
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  if (/^NO_SEARCH[.!]?$/i.test(clean)) return null;
  const parsed = parseArgs(clean);
  return parsed && Object.hasOwn(parsed, 'query') ? parsed.query : undefined;
}

export async function planWebSearch(input, key, ollamaBaseUrl, { signal, fetchImpl = fetch } = {}) {
  const question = latestQuestion(input);
  const fallback = normalizeSearchQuery(question.replace(/\s+/g, ' ').slice(0, 180));
  const useFallback = () => input.searchMode === 'always' || likelyNeedsSearch(question) ? fallback : null;
  const plan = buildSearchPlanRequest(input, key, ollamaBaseUrl);
  try {
    const response = await fetchImpl(plan.url, {
      ...plan.options, signal: AbortSignal.any([AbortSignal.timeout(9_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) {
        throw new RequestError(response.status, friendlyUpstreamError(response.status, await response.text(), key));
      }
      return useFallback(); // Some free models do not support function calling.
    }
    const raw = await response.text();
    if (raw.length > 30_000) return useFallback();
    const payload = JSON.parse(raw);
    if (input.provider === 'openrouter' && payload.model &&
        (payload.model === 'openrouter/free' || isNonChatModelId(payload.model))) {
      throw new RequestError(502, 'OpenRouter returned a safety or utility model instead of a coding assistant.');
    }
    const decision = parseSearchDecision(input.provider, payload);
    if (decision === null && input.searchMode === 'auto') return null;
    return normalizeSearchQuery(decision) || useFallback();
  } catch (error) {
    if (error instanceof RequestError || signal?.aborted) throw error;
    return useFallback(); // Planning should not prevent a requested search.
  }
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 600) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.hostname === 'localhost' || url.hostname.endsWith('.local') ||
        /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
    return url.toString();
  } catch { return null; }
}

export function normalizeSearchResults(data) {
  if (!Array.isArray(data?.results)) throw new RequestError(502, 'The search service returned an invalid response.');
  const seen = new Set();
  const sources = [];
  for (const item of data.results.slice(0, 15)) {
    const url = safeSourceUrl(item?.url);
    if (!url || seen.has(url)) continue;
    const title = cleanText(item.title, 140) || new URL(url).hostname;
    const snippet = cleanText(item.content ?? item.snippet, 500);
    const date = typeof item.published_date === 'string' ? new Date(item.published_date) : null;
    seen.add(url);
    sources.push({ title, url, snippet, ...(date && !Number.isNaN(date.valueOf()) ? { publishedDate: date.toISOString().slice(0, 10) } : {}) });
    if (sources.length >= 5) break;
  }
  return sources;
}

export async function searchWeb(query, key = '', { signal, fetchImpl = fetch } = {}) {
  const safeQuery = normalizeSearchQuery(query);
  if (!safeQuery) throw new RequestError(400, 'Could not form a safe web search query. Remove secrets or private details and try again.');
  const timeout = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
  let response;
  try {
    response = XWEB_BASE
      ? await fetchImpl(`${XWEB_BASE}/api/v1/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key || XWEB_KEY ? { 'X-XWeb-Key': key || XWEB_KEY } : {}) },
        body: JSON.stringify({
          query: safeQuery,
          max_results: 5,
          include_answer: false,
          // The reason to use it at all: every configured provider is queried
          // at once, then deduplicated and reranked into one list.
          multi_source: true,
        }),
        signal: timeout,
      })
      : await fetchImpl(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : { 'X-Tavily-Access-Mode': 'keyless' }) },
        body: JSON.stringify({ query: safeQuery, search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, include_images: false, include_published_date: true, safe_search: true }),
        signal: timeout,
      });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RequestError(502, 'Live web search is unavailable. Try again or switch Search off.');
  }
  if (!response.ok) {
    if (XWEB_BASE) {
      let body = null;
      try { body = JSON.parse(await response.text()); } catch { /* not JSON; the status is the message */ }
      const message = xWebMessage(response.status, body);
      throw new RequestError(response.status === 429 ? 429 : 502, message);
    }
    if ([429, 432, 433].includes(response.status)) throw new RequestError(429, 'Web search reached a rate limit. Try later or add a free Tavily key in Settings.');
    if (response.status === 401 || response.status === 403) throw new RequestError(502, 'The Tavily search key was rejected. Update it in Settings or clear it to use rate-limited keyless search.');
    throw new RequestError(502, 'The web search service is unavailable. Try again or switch Search off.');
  }
  let data;
  try {
    const text = await response.text();
    if (text.length > 250_000) throw new Error('Response too large');
    data = JSON.parse(text);
  } catch { throw new RequestError(502, 'The web search service returned an invalid response.'); }
  return normalizeSearchResults(data);
}

export function withSearchContext(input, query, sources, now = new Date()) {
  const results = sources.map((source, index) => ({
    ref: index + 1, title: source.title, url: source.url, snippet: source.snippet,
    ...(source.publishedDate ? { publishedDate: source.publishedDate } : {}),
  }));
  const messages = input.messages.map((message, index) => index === input.messages.length - 1 ? {
    ...message,
    content: `${message.content}\n\n<untrusted_web_search_data>\n${JSON.stringify({ query, retrievedAt: now.toISOString(), results })}\n</untrusted_web_search_data>`,
  } : message);
  return {
    ...input, messages, searchPerformed: true,
    systemPrompt: buildAssistantPrompt({ provider: input.provider, model: input.model, searchMode: input.searchMode, searchPerformed: true, canvasFiles: input.canvasFiles }),
  };
}
