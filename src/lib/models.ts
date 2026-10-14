import curated from '../data/models.json';
import type { ModelInfo, Provider } from '../types';

// AIFLUX family is injected client-side so it shows up even before the
// /api/models response returns. The server serves the same entries from
// listAIFluxModels() and merges them at the top of /api/models.
const AIFLUX_FAMILY: ModelInfo[] = [
  {
    id: 'flux', provider: 'aiflux',
    name: 'AIFLUX Flux', shortName: 'Flux · Smart',
    description: 'Flagship AIFLUX agent — works instantly with NO API KEY needed. Built-in free endpoints plus deep web search. Super smart general chat, reasoning, and coding.',
    strength: 'Built-in · super smart', badge: 'DEFAULT',
  },
  {
    id: 'hiku', provider: 'aiflux',
    name: 'AIFLUX Hiku', shortName: 'Hiku · Coder',
    description: 'Coding specialist. Picks the strongest connected free coding model and routes through it.',
    strength: 'Smart coding', badge: 'CODER',
  },
  {
    id: 'siku', provider: 'aiflux',
    name: 'AIFLUX Siku', shortName: 'Siku · Think',
    description: 'A deeper-reasoning AIFLUX agent for architecture, debugging hard problems, and trade-off analysis.',
    strength: 'Deep reasoning', badge: 'REASONING',
  },
  {
    id: 'ziker', provider: 'aiflux',
    name: 'AIFLUX Ziker', shortName: 'Ziker · Plan',
    description: 'Planner that breaks big asks into steps, sketches file structure, and sequences edits before writing.',
    strength: 'Planning', badge: 'PLANNER',
  },
  {
    id: 'toki', provider: 'aiflux',
    name: 'AIFLUX Toki', shortName: 'Toki · Search',
    description: 'Live-web agent: automatically searches, grounds answers in cited sources, and keeps claims current.',
    strength: 'Live search', badge: 'LIVE WEB',
  },
  {
    id: 'zuki', provider: 'aiflux',
    name: 'AIFLUX Zuki', shortName: 'Zuki · Vision',
    description: 'Routes to a free multimodal model when available. Vision/image input UI coming soon.',
    strength: 'Vision', badge: 'VISION',
  },
];

export const CURATED_MODELS: ModelInfo[] = [...AIFLUX_FAMILY, ...(curated as ModelInfo[])];
export const DEFAULT_MODEL = CURATED_MODELS[0];

export const PROVIDERS: Record<Provider, { name: string; initial: string; description: string; url: string; color: string }> = {
  aiflux: {
    name: 'AIFLUX', initial: '✳',
    description: 'Flux (default, no key needed) — built-in free AI with deep search. Plus Hiku (coder), Siku (thinking), Ziker (planner), Toki (live web), Zuki (vision).',
    url: '#', color: 'gold',
  },
  openrouter: {
    name: 'OpenRouter', initial: 'O',
    description: 'One key, a changing catalog of free open models.',
    url: 'https://openrouter.ai/keys', color: 'violet',
  },
  gemini: {
    name: 'Google Gemini', initial: '✦',
    description: 'Google AI Studio offers a free API tier for select models.',
    url: 'https://aistudio.google.com/apikey', color: 'blue',
  },
  groq: {
    name: 'Groq', initial: 'G',
    description: 'Fast inference for open-weight models on Groq’s free plan.',
    url: 'https://console.groq.com/keys', color: 'orange',
  },
  ollama: {
    name: 'Ollama', initial: '◉',
    description: 'Run models privately on the machine hosting AIFLUX.',
    url: 'https://github.com/ollama/ollama', color: 'lime',
  },
};

export function modelDisplayName(modelId: string, allModels: ModelInfo[]): string {
  return allModels.find((model) => model.id === modelId)?.name || modelId.split('/').at(-1)?.replace(':free', '') || modelId;
}

export function groupModels(models: ModelInfo[]): { provider: Provider; models: ModelInfo[] }[] {
  return (['aiflux', 'openrouter', 'gemini', 'groq', 'ollama'] as Provider[])
    .map((provider) => ({ provider, models: models.filter((model) => model.provider === provider) }))
    .filter((group) => group.models.length > 0);
}
