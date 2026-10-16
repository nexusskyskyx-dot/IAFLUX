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
    url: 'https://github.com/ollama/ollama', color: 'green',
  },
  xkiro: {
    name: 'xKiro', initial: 'X',
    description: 'One OpenAI-compatible key for a large catalogue of models, 50+ of them free.',
    url: 'https://xkiro.com/register', color: 'teal',
  },
};

export function modelDisplayName(modelId: string, allModels: ModelInfo[]): string {
  return allModels.find((model) => model.id === modelId)?.name || modelId.split('/').at(-1)?.replace(':free', '') || modelId;
}

export function groupModels(models: ModelInfo[]): { provider: Provider; models: ModelInfo[] }[] {
  return (['openrouter', 'gemini', 'groq', 'ollama', 'xkiro'] as Provider[])
    .map((provider) => ({ provider, models: models.filter((model) => model.provider === provider) }))
    .filter((group) => group.models.length > 0);
}
