import type { Conversation, Credentials, ModelInfo, SearchMode } from '../types';
import { CURATED_MODELS, DEFAULT_MODEL } from './models';
import { isNonChatModelId, isSelectableOpenRouterId } from './model-policy.mjs';

const CHATS_KEY = 'aiflux.conversations.v1';
const ACTIVE_KEY = 'aiflux.active.v1';
const MODEL_KEY = 'aiflux.model.v1';
const CREDS_KEY = 'aiflux.credentials.v1';
const SEARCH_MODE_KEY = 'aiflux.search-mode.v1';

export function loadConversations(): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((chat): chat is Conversation => Boolean(
      chat && typeof chat.id === 'string' && Array.isArray(chat.messages) && Array.isArray(chat.files)
    )).slice(0, 40);
  } catch { return []; }
}

export function saveConversations(chats: Conversation[]): boolean {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 40)));
    return true;
  } catch { return false; }
}

export function loadActiveId(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

export function saveActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* Storage may be unavailable. */ }
}

function validSavedModel(): ModelInfo | null {
  try {
    const parsed: ModelInfo = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null');
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null;
    if (parsed.provider === 'openrouter') return isSelectableOpenRouterId(parsed.id) ? parsed : null;
    if (parsed.provider === 'ollama') return /^[a-zA-Z0-9._:/-]{1,160}$/.test(parsed.id) && !isNonChatModelId(parsed.id) ? parsed : null;
    // Retired native-provider selections must not survive a catalog update.
    return CURATED_MODELS.some((model) => model.provider === parsed.provider && model.id === parsed.id) ? parsed : null;
  } catch { return null; }
}

export function hasSavedModel(): boolean {
  return validSavedModel() !== null;
}

export function loadModel(): ModelInfo {
  const saved = validSavedModel();
  if (saved) return saved;
  // Clear legacy Auto-free and safety-model selections from earlier releases.
  try { localStorage.removeItem(MODEL_KEY); } catch { /* Use the default in memory. */ }
  return DEFAULT_MODEL;
}

export function saveModel(model: ModelInfo) {
  try { localStorage.setItem(MODEL_KEY, JSON.stringify(model)); } catch { /* Use in memory. */ }
}

export function loadSearchMode(): SearchMode {
  try {
    const value = localStorage.getItem(SEARCH_MODE_KEY);
    return value === 'auto' || value === 'always' ? value : 'off';
  } catch { return 'off'; }
}

export function saveSearchMode(mode: SearchMode) {
  try { localStorage.setItem(SEARCH_MODE_KEY, mode); } catch { /* In-memory preference still works. */ }
}

export function loadCredentials(): Credentials {
  const empty: Credentials = { keys: { openrouter: '', gemini: '', groq: '' }, accessCode: '', searchKey: '', remember: false };
  try {
    const persistent = localStorage.getItem(CREDS_KEY);
    const raw = persistent || sessionStorage.getItem(CREDS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      keys: {
        openrouter: String(parsed.keys?.openrouter || ''),
        gemini: String(parsed.keys?.gemini || ''),
        groq: String(parsed.keys?.groq || ''),
      },
      accessCode: String(parsed.accessCode || ''),
      searchKey: String(parsed.searchKey || ''),
      remember: Boolean(persistent),
    };
  } catch { return empty; }
}

export function saveCredentials(credentials: Credentials) {
  try {
    localStorage.removeItem(CREDS_KEY);
    sessionStorage.removeItem(CREDS_KEY);
    (credentials.remember ? localStorage : sessionStorage).setItem(CREDS_KEY, JSON.stringify(credentials));
  } catch { /* In-memory connection remains usable. */ }
}
