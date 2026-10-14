// AIFLUX-branded assistant family.
//
// The client exposes six named personas (Flux, Hiku, Siku, Ziker, Toki, Zuki)
// under the "aiflux" pseudo-provider. For each chat request the server picks
// the best concrete provider+model from a priority list that matches the
// persona's specialty. Candidates are tried in order:
//   1. Built-in keyless public free endpoints (pollinations / ovh / llm7) —
//      these work out of the box with zero API keys from the user.
//   2. User-supplied keys (Gemini, OpenRouter, Groq).
//   3. Server env keys.
//   4. Ollama, if connected.
//
// Selection is request-scoped: we don't pin a model across turns, so if a
// provider taps out (rate limit / outage) you can simply send again and
// AIFLUX will pick another.

import { RequestError } from './providers.mjs';

// Built-in keyless public free endpoints. These require NO API key from the
// user or the deployer; AIFLUX calls them directly server-side.
export const KEYLESS_PROVIDERS = Object.freeze(new Set(['pollinations', 'ovh']));

export const AIFLUX_MEMBERS = Object.freeze({
  flux: {
    name: 'Flux',
    role: 'Smart Agent',
    badge: 'DEFAULT',
    color: 'gold',
    shortName: 'Flux · Smart',
    description: 'Flagship AIFLUX agent. Works out of the box with no API key — built-in free endpoints first, then your connected keys. Super smart general-purpose chat, reasoning, and coding assistant with deep web search.',
    strength: 'Built-in · super smart',
    systemAddendum: [
      'You are Flux, the flagship AIFLUX Smart Agent.',
      'You are the default assistant for this workspace and you work immediately — no API key required.',
      'Your job is to be extremely helpful, accurate, and thorough: answer questions, write and debug code, reason through problems, and use the Canvas tools when editing files.',
      'Web search is available automatically: when current facts, documentation versions, release notes, pricing, news, or live information would improve an answer, search deeply across sources, cross-check facts, cite numbered references, and prefer primary sources (official docs, release notes, GitHub) over secondhand summaries. For simple greetings, code edits, reasoning, and explanations, do not search — just answer directly.',
      'Prefer exact Canvas tools over prose when the user asks for code changes, and verify with view_preview after edits.',
      'Think step-by-step on hard problems but keep prose concise and practical. Be honest when you are unsure.',
    ].join(' '),
  },
  hiku: {
    name: 'Hiku',
    role: 'Coder',
    badge: 'CODER',
    color: 'lime',
    shortName: 'Hiku · Coder',
    description: 'Precise coding agent. Uses the strongest connected free coding model for edits, refactors, and debugging.',
    strength: 'Smart coding',
    systemAddendum: 'You are Hiku, the AIFLUX Coder. Your job is to build, debug, and refactor code accurately. Prefer exact Canvas tools over prose, verify via view_preview after edits, and keep answers tight and practical. You write real, runnable code.',
  },
  siku: {
    name: 'Siku',
    role: 'Thinking agent',
    badge: 'REASONING',
    color: 'violet',
    shortName: 'Siku · Think',
    description: 'A deeper-reasoning agent for architecture, trade-offs, debugging hard problems, and long multi-step plans.',
    strength: 'Deep reasoning',
    systemAddendum: 'You are Siku, the AIFLUX Thinking agent. Before editing Canvas files, reason through the problem, weigh trade-offs, and call out risks or assumptions. You may ask one clarifying question if a requirement is genuinely ambiguous; otherwise propose a concrete plan and execute it step by step. Show your reasoning in plain prose before showing code.',
  },
  ziker: {
    name: 'Ziker',
    role: 'Planner',
    badge: 'PLANNER',
    color: 'blue',
    shortName: 'Ziker · Plan',
    description: 'Breaks big asks into small checklists, sketches file/project structure, and sequences Canvas edits before making them.',
    strength: 'Planning',
    systemAddendum: 'You are Ziker, the AIFLUX Planner. When given a build request, start by listing a short concrete plan (files to create/change, steps in order) and then execute it with the Canvas tools. If the request is vague, produce a 3-5 step plan and ask a single targeted question before coding. Prefer edit_file over write_file to preserve existing work.',
  },
  toki: {
    name: 'Toki',
    role: 'Live web',
    badge: 'LIVE WEB',
    color: 'cyan',
    shortName: 'Toki · Search',
    description: 'Automatically uses live web search when needed, then grounds answers in cited sources. Best for current facts, docs, and releases.',
    strength: 'Live search',
    systemAddendum: 'You are Toki, the AIFLUX Live-Web agent. The Web toggle is effectively "always" for you: when current facts, documentation versions, release notes, or pricing matter, rely on the supplied search results, cite numbered sources, and be honest when sources conflict or are missing. Do not invent URLs.',
    forceSearch: true,
  },
  zuki: {
    name: 'Zuki',
    role: 'Vision',
    badge: 'VISION',
    color: 'coral',
    shortName: 'Zuki · Vision',
    description: 'Routes to a free multimodal model for images and screenshots when available. Marked preview until image input ships in the Canvas.',
    strength: 'Vision',
    systemAddendum: 'You are Zuki, the AIFLUX Vision agent. You will receive image inputs (when provided) and should describe, explain, or modify the visual content accordingly. When building from a screenshot, reconstruct HTML/CSS that matches the layout. Until image upload lands, politely note that vision input is coming soon.',
  },
});

// Priority list of (provider, modelId) candidates per member. The router walks
// these in order and picks the first available provider. Keyless public
// endpoints are always available (no key needed) and are tried first for Flux.
const CANDIDATES = Object.freeze({
  flux: [
    // Priority ordering: strongest-free-and-fast first, with multi-route
    // failover. Keyed providers are placed above keyless public endpoints
    // because they are far more reliable, faster, and smarter — Flux should
    // never wait on a shaky anonymous tier when a real key is available.
    // Within each tier we prefer models known for coding + tool use + speed.
    //
    // Tier 1 — User-keyed providers (fastest, most reliable).
    { provider: 'gemini', model: 'gemini-3.8-flash' },        // ~98 tok/s, strong coder
    { provider: 'groq', model: 'openai/gpt-oss-120b' },       // 271 tok/s, 97% pass on coding bench
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },          // fast, strong
    { provider: 'groq', model: 'openai/gpt-oss-20b' },        // fastest on Groq
    { provider: 'gemini', model: 'gemini-2.5-flash' },        // reliable free fallback
    { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
    //
    // Tier 2 — OpenRouter :free models, ranked by SWE-bench / LiveCodeBench
    // strength. The strongest free coding/reasoning models currently
    // published; rotate if any rotate off free.
    { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },       // #1 free coder, 1M ctx, tool use
    { provider: 'openrouter', model: 'deepseek/deepseek-r1:free' },   // #1 free reasoning
    { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, // 550B, 1M ctx
    { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'openrouter', model: 'poolside/laguna-m.1:free' },
    { provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'openrouter', model: 'poolside/laguna-xs.2:free' },
    { provider: 'openrouter', model: 'openai/gpt-oss-20b:free' },
    { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
    //
    // Tier 3 — Built-in keyless public endpoints (zero-config fallback for
    // first-time visitors). These are last because anonymous tiers are
    // slower, more rate-limited, and occasionally return malformed SSE;
    // the multi-route failover silently retries them.
    { provider: 'pollinations', model: 'openai' },
    { provider: 'ovh', model: 'mistralai/Mistral-Nemo-Instruct-2407' },
    { provider: 'ovh', model: 'meta-llama/Llama-3.3-70B-Instruct' },
  ],
  hiku: [
    // Hiku is the coding specialist. Rank by SWE-bench / LiveCodeBench.
    { provider: 'groq', model: 'openai/gpt-oss-120b' },       // 271 tok/s, 97% pass
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
    { provider: 'openrouter', model: 'poolside/laguna-m.1:free' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'openrouter', model: 'poolside/laguna-xs.2:free' },
    { provider: 'openrouter', model: 'openai/gpt-oss-20b:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
  ],
  siku: [
    // Siku is the reasoning agent. Prioritize reasoning specialists (DeepSeek
    // R1, Nemotron Ultra/Super) and the fastest general smart models.
    { provider: 'openrouter', model: 'deepseek/deepseek-r1:free' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
  ],
  ziker: [
    // Ziker is the planner. Strong structured-output / instruction-following
    // models first; fast compact models are fine since plans are short.
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free' },
    { provider: 'openrouter', model: 'poolside/laguna-xs.2:free' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
  ],
  toki: [
    // Toki does web-search planning. Needs reliable structured output and
    // fast response — Gemini 3.8 Flash is ideal, then fast Groq models.
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  ],
  zuki: [
    // Multimodal vision routing. Gemma 4 31B and Gemini Flash families accept
    // images on the free tier.
    { provider: 'gemini', model: 'gemini-3.8-flash', vision: true },
    { provider: 'gemini', model: 'gemini-2.5-flash', vision: true },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite', vision: true },
    { provider: 'openrouter', model: 'google/gemma-4-31b-it:free', vision: true },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'gemini', model: 'gemini-3.8-flash' },
  ],
});

export function listAIFluxModels() {
  return Object.entries(AIFLUX_MEMBERS).map(([id, meta]) => ({
    id,
    provider: 'aiflux',
    name: `AIFLUX ${meta.name}`,
    shortName: meta.shortName,
    description: meta.description,
    strength: meta.strength,
    badge: meta.badge,
    _meta: meta,
  }));
}

export function memberInfo(memberId) {
  const info = AIFLUX_MEMBERS[memberId];
  if (!info) throw new RequestError(400, `Unknown AIFLUX family member "${memberId}".`);
  return info;
}

/**
 * Pick the best concrete (provider, model) for the given AIFLUX member,
 * given which keys are currently available. Keyless public providers are
 * always considered connected.
 *
 * @param {string} memberId
 * @param {{openrouter: string, gemini: string, groq: string}} userKeys
 * @param {{openrouter: string, gemini: string, groq: string}} envKeys
 * @param {boolean} ollamaConfigured
 */
export function resolveAIFluxRoute(memberId, userKeys, envKeys, ollamaConfigured) {
  const routes = resolveAIFluxRoutes(memberId, userKeys, envKeys, ollamaConfigured);
  return routes[0];
}

/**
 * Return an ordered list of all viable (provider, model, key) routes for a
 * member. The chat handler walks these and transparently fails over to the
 * next when an upstream returns a 5xx / 429 / empty / malformed response —
 * so a keyless endpoint that misbehaves (e.g. returns an SSE stream with no
 * content, or "invalid or omitted terminal usage") immediately falls through
 * to the next working provider without the user seeing an error.
 */
export function resolveAIFluxRoutes(memberId, userKeys, envKeys, ollamaConfigured) {
  const info = memberInfo(memberId);
  const keyFor = (provider) => {
    if (KEYLESS_PROVIDERS.has(provider) || provider === 'ollama') return '';
    return (userKeys[provider] || '').trim() || (envKeys[provider] || '').trim();
  };
  const connected = (provider) => {
    if (KEYLESS_PROVIDERS.has(provider)) return true;
    if (provider === 'ollama') return ollamaConfigured;
    return Boolean(keyFor(provider));
  };
  const candidates = CANDIDATES[memberId] || [];
  const routes = [];
  for (const candidate of candidates) {
    if (!connected(candidate.provider)) continue;
    routes.push({
      ...candidate,
      key: keyFor(candidate.provider),
      memberAddendum: info.systemAddendum,
      forceSearch: Boolean(info.forceSearch),
      keyless: KEYLESS_PROVIDERS.has(candidate.provider),
    });
  }
  if (routes.length === 0) {
    throw new RequestError(400,
      `AIFLUX ${info.name} needs at least one connected model provider. Connect a free Gemini, OpenRouter, or Groq key in Settings to use ${info.name}.`);
  }
  return routes;
}
