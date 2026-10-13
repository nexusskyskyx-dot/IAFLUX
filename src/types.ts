export type Provider = 'openrouter' | 'gemini' | 'groq' | 'ollama';

export interface ModelInfo {
  id: string;
  provider: Provider;
  name: string;
  shortName: string;
  description: string;
  strength: string;
  badge: string;
  contextLength?: number;
}

export interface AttachedFile {
  name: string;
  content: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status?: 'streaming' | 'done' | 'error';
  model?: string;
  attachments?: AttachedFile[];
}

export interface WorkspaceFile {
  id: string;
  name: string;
  content: string;
  origin: 'starter' | 'generated' | 'user';
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  files: WorkspaceFile[];
  selectedFileId: string | null;
}

export interface AppConfig {
  configured: Record<'openrouter' | 'gemini' | 'groq', boolean>;
  ollamaConfigured: boolean;
  requiresAccessCode: boolean;
}

export interface Credentials {
  keys: Record<'openrouter' | 'gemini' | 'groq', string>;
  accessCode: string;
  remember: boolean;
}

export interface CatalogResponse {
  models: ModelInfo[];
  ollamaModels: ModelInfo[];
  catalogAvailable: boolean;
}
