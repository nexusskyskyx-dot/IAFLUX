import type { DiffLine } from './lib/diff';

export type Provider = 'openrouter' | 'gemini' | 'groq' | 'ollama' | 'xkiro';
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
  /** Which extra attempt is currently filling this in, once a time limit cut it short. */
  continuation?: number;
  /** Ended at the request limit rather than because the model was finished. */
  truncated?: boolean;
  /** Files the assistant wrote straight to the canvas during this answer. */
  fileOps?: FileOpResult[];
  /** Pages the assistant opened to answer this message. */
  browses?: BrowseResult[];
  /** True while those pages are being opened. */
  browsing?: boolean;
  attachments?: AttachedFile[];
  search?: { query: string; sources: WebSource[] };
  searchSkipped?: boolean;
  searchStatus?: 'planning' | 'searching';
  searchQuery?: string;
}

/** A page the assistant opened with <url_fetch>. */
export interface BrowseResult {
  url: string;
  ok: boolean;
  title?: string;
  /** Why it could not be read, when it could not. */
  error?: string;
  /** What the page said, condensed for the model: text plus design signals. */
  summary?: string;
  /** Sites a design gallery was featuring, when that is what was opened. */
  references?: { name: string; url: string }[];
}

/** A file operation the assistant emitted. */
export interface FileOp {
  action: 'write' | 'patch' | 'delete';
  path: string;
  /** Full new contents, for `write`. */
  content?: string;
  /** SEARCH/REPLACE pairs, for `patch`. */
  hunks?: { search: string; replace: string }[];
}

export interface FileOpResult {
  path: string;
  action: FileOp['action'];
  status: 'applied' | 'failed';
  added: number;
  removed: number;
  diff: DiffLine[];
  fileId?: string;
  error?: string;
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
  configured: Record<'openrouter' | 'gemini' | 'groq' | 'xkiro', boolean>;
  ollamaConfigured: boolean;
  searchConfigured: boolean;
  /** Which search backend the workspace uses, so the Settings copy can be true. */
  searchBackend?: 'x-web' | 'tavily';
  requiresAccessCode: boolean;
}

export interface Credentials {
  keys: Record<'openrouter' | 'gemini' | 'groq' | 'xkiro', string>;
  accessCode: string;
  searchKey: string;
  remember: boolean;
}

export interface CatalogResponse {
  models: ModelInfo[];
  ollamaModels: ModelInfo[];
  xkiroModels: ModelInfo[];
  catalogAvailable: boolean;
  xkiroAvailable: boolean;
}
