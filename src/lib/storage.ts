import type { Conversation, Credentials, ModelInfo } from '../types';
import { DEFAULT_MODEL } from './models';

const CHATS_KEY = 'aiflux.conversations.v1';
const ACTIVE_KEY = 'aiflux.active.v1';
const MODEL_KEY = 'aiflux.model.v1';
const CREDS_KEY = 'aiflux.credentials.v1';

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

export function loadModel(): ModelInfo {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null');
    if (parsed && typeof parsed.id === 'string' && typeof parsed.provider === 'string' && typeof parsed.name === 'string') return parsed;
  } catch { /* Use default. */ }
  return DEFAULT_MODEL;
}

export function saveModel(model: ModelInfo) {
  try { localStorage.setItem(MODEL_KEY, JSON.stringify(model)); } catch { /* Use in memory. */ }
}

export function loadCredentials(): Credentials {
  const empty: Credentials = { keys: { openrouter: '', gemini: '', groq: '' }, accessCode: '', remember: false };
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
