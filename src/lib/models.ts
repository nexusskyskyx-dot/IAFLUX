import curated from '../data/models.json';
import type { ModelInfo, Provider } from '../types';

export const CURATED_MODELS = curated as ModelInfo[];
export const DEFAULT_MODEL = CURATED_MODELS[0];

export const PROVIDERS: Record<Provider, { name: string; initial: string; description: string; url: string; color: string }> = {
  openrouter: {
    name: 'OpenRouter', initial: 'O',
    description: 'One key, a changing catalog of free open models.',
    url: 'https://openrouter.ai/keys', color: 'violet',
  },
  xkiro: {
    name: 'xKiro', initial: 'xK',
    description: 'Live free chat models; a daily token allowance applies.',
    url: 'https://xkiro.com/dashboard/api/keys', color: 'cyan',
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
  return (['xkiro', 'openrouter', 'gemini', 'groq', 'ollama'] as Provider[])
    .map((provider) => ({ provider, models: models.filter((model) => model.provider === provider) }))
    .filter((group) => group.models.length > 0);
}

export function recommendedModelForProvider(provider: Provider, models: ModelInfo[]): ModelInfo | undefined {
  const available = models.filter((model) => model.provider === provider);
  const noKnownPrice = available.filter((model) => model.badge !== 'CHECK PRICING');
  return noKnownPrice.find((model) => model.badge.startsWith('BEST')) ||
    noKnownPrice.find((model) => /coding|software.engineering|code/i.test(model.strength)) ||
    noKnownPrice[0];
}
