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
      'When web search is enabled, search deeply across sources, cross-check facts, cite numbered references, and prefer primary sources (official docs, release notes, GitHub) over secondhand summaries.',
      'Prefer exact Canvas tools over prose when the user asks for code changes, and verify with view_preview after edits.',
      'Think step-by-step on hard problems but keep prose concise and practical. Be honest when you are unsure.',
    ].join(' '),
    forceSearch: true,
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
    // Built-in keyless public free endpoints — no API key needed from user.
    // Pollinations anonymous tier (text.pollinations.ai/openai) — OpenAI-compatible,
    // no key, rate-limited per IP. Routes to their current anonymous model (GPT-OSS 20B).
    { provider: 'pollinations', model: 'openai' },
    // OVHcloud AI Endpoints anonymous tier — OpenAI-compatible, no key, 2 RPM/IP.
    // Mistral Small and Llama variants are available keyless.
    { provider: 'ovh', model: 'mistralai/Mistral-Nemo-Instruct-2407' },
    { provider: 'ovh', model: 'meta-llama/Llama-3.3-70B-Instruct' },
    // User-connected keys (strongest free models, preferred after keyless).
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    { provider: 'openrouter', model: 'poolside/laguna-m.1:free' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
  ],
  hiku: [
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'openrouter', model: 'poolside/laguna-m.1:free' },
    { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
  ],
  siku: [
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
  ],
  ziker: [
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'openrouter', model: 'poolside/laguna-xs.2:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
  ],
  toki: [
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
  ],
  zuki: [
    { provider: 'gemini', model: 'gemini-3.8-flash', vision: true },
    { provider: 'gemini', model: 'gemini-2.5-flash', vision: true },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite', vision: true },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
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
  const info = memberInfo(memberId);
  const hasKey = (provider) => Boolean((userKeys[provider] || '').trim() || (envKeys[provider] || '').trim());
  const connected = (provider) => {
    if (KEYLESS_PROVIDERS.has(provider)) return true; // built-in, always available
    if (provider === 'ollama') return ollamaConfigured;
    return hasKey(provider);
  };
  const candidates = CANDIDATES[memberId] || [];
  for (const candidate of candidates) {
    if (connected(candidate.provider)) {
      return {
        ...candidate,
        memberAddendum: info.systemAddendum,
        forceSearch: Boolean(info.forceSearch),
        keyless: KEYLESS_PROVIDERS.has(candidate.provider),
      };
    }
  }
  // Should never happen because keyless providers are always available for
  // members that list them (i.e. Flux). For members that don't (e.g. Zuki
  // vision-first), fall through to a helpful error.
  throw new RequestError(400,
    `AIFLUX ${info.name} needs at least one connected model provider. Connect a free Gemini, OpenRouter, or Groq key in Settings to use ${info.name}.`);
}
