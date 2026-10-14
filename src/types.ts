export type KeyProvider = 'openrouter' | 'xkiro' | 'gemini' | 'groq';
export type Provider = KeyProvider | 'ollama';
export type SearchMode = 'off' | 'auto' | 'always';

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

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
  search?: { query: string; sources: WebSource[] };
  searchSkipped?: boolean;
  searchStatus?: 'planning' | 'searching';
  searchQuery?: string;
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
  configured: Record<KeyProvider, boolean>;
  ollamaConfigured: boolean;
  searchConfigured: boolean;
  requiresAccessCode: boolean;
}

export interface Credentials {
  keys: Record<KeyProvider, string>;
  accessCode: string;
  searchKey: string;
  remember: boolean;
  autoSelectOnConnect: boolean;
}

export interface CatalogResponse {
  models: ModelInfo[];
  xkiroModels: ModelInfo[];
  ollamaModels: ModelInfo[];
  catalogAvailable: boolean;
  xkiroCatalogAvailable: boolean;
}
