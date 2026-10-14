import type { Provider, SearchMode, WebSource } from '../types';

export type StreamEvent =
  | { type: 'start' | 'model' | 'done'; model: string }
  | { type: 'delta'; text: string }
  | { type: 'search'; phase: 'planning' | 'searching' | 'skipped'; query?: string }
  | { type: 'sources'; query: string; sources: WebSource[] }
  | { type: 'orchestrator'; phase: 'start' | 'planning' | 'research' | 'coding' | 'reviewing'; label: string; description: string }
  | { type: 'error'; message: string };

export async function requestChat(input: {
  provider: Provider;
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  keys: Record<'openrouter' | 'gemini' | 'groq', string>;
  searchKey: string;
  searchMode: SearchMode;
  accessCode: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-aiflux-keys': encodeURIComponent(JSON.stringify(input.keys)),
      ...(input.searchMode !== 'off' && input.searchKey ? { 'x-aiflux-search-key': input.searchKey } : {}),
      ...(input.accessCode ? { 'x-aiflux-access-code': input.accessCode } : {}),
    },
    body: JSON.stringify({ provider: input.provider, model: input.model, messages: input.messages, searchMode: input.searchMode }),
    signal: input.signal,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(typeof json.error === 'string' ? json.error : `Request failed (${response.status}).`);
  }
  if (!response.body) throw new Error('The provider did not return a response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          const event = JSON.parse(data) as StreamEvent;
          input.onEvent(event);
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'done') finished = true;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    if (!finished && !input.signal.aborted) throw new Error('The connection closed before the answer finished.');
  } finally {
    reader.releaseLock();
  }
}
