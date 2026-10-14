// AIFLUX-branded assistant family.
//
// The client exposes five named personas (Siku, Hiku, Ziker, Toki, Zuki) under
// the "aiflux" pseudo-provider. For each chat request the server picks the
// best concrete provider+model from a priority list that matches the persona's
// specialty, falling back through whichever providers actually have a key
// (user-supplied > server env > Ollama).
//
// Selection is request-scoped: we don't pin a model across turns, so if a key
// runs out of quota you can simply send again and AIFLUX will pick another.

import { RequestError } from './providers.mjs';

export const AIFLUX_MEMBERS = Object.freeze({
  hiku: {
    name: 'Hiku',
    role: 'Coder',
    badge: 'DEFAULT',
    color: 'lime',
    shortName: 'Hiku · Coder',
    description: 'Default AIFLUX coding agent. Precise edits, clear explanations, tool-forward. Picks the strongest connected free coding model.',
    strength: 'Smart coding',
    systemAddendum: 'You are Hiku, the AIFLUX Coder. You are the default assistant for this workspace: your job is to build, debug, and refactor code accurately. Prefer exact Canvas tools over prose, verify via view_preview after edits, and keep answers tight and practical. You write real, runnable code.',
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
    // If no vision-capable model is connected, Zuki falls back to the best
    // available text model with a note.
  },
});

// Priority list of (provider, modelId) candidates per member. The router walks
// these in order and picks the first whose provider has a key available.
const CANDIDATES = Object.freeze({
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
    // Search planning works best on reliable structured-output models.
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'openrouter', model: 'cohere/north-mini-code:free' },
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
  ],
  zuki: [
    // Gemini Flash accepts image inputs on the free tier; route Zuki there
    // when a key is available. Otherwise drop through to a text model with
    // a "vision coming soon" note in its system prompt.
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
 * Pick the best concrete (provider, model, isVision) for the given AIFLUX
 * member, given which keys are currently available.
 *
 * @param {string} memberId
 * @param {{openrouter: string, gemini: string, groq: string}} userKeys
 * @param {{openrouter: string, gemini: string, groq: string}} envKeys
 * @param {boolean} ollamaConfigured
 */
export function resolveAIFluxRoute(memberId, userKeys, envKeys, ollamaConfigured) {
  const info = memberInfo(memberId);
  const connected = (provider) => {
    if (provider === 'ollama') return ollamaConfigured;
    return Boolean((userKeys[provider] || '').trim() || (envKeys[provider] || '').trim());
  };
  const candidates = CANDIDATES[memberId] || [];
  for (const candidate of candidates) {
    if (connected(candidate.provider)) {
      return { ...candidate, memberAddendum: info.systemAddendum, forceSearch: Boolean(info.forceSearch) };
    }
  }
  throw new RequestError(400,
    `AIFLUX ${info.name} needs at least one connected model provider. Connect a free Gemini, OpenRouter, or Groq key in Settings to use ${info.name}.`);
}
