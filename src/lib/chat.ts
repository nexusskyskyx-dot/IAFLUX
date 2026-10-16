import type { Provider, SearchMode, WebSource } from '../types';

export type StreamEvent =
  | { type: 'start' | 'model' | 'done'; model: string }
  | { type: 'delta'; text: string }
  | { type: 'search'; phase: 'planning' | 'searching' | 'skipped'; query?: string }
  | { type: 'sources'; query: string; sources: WebSource[] }
  | { type: 'error'; message: string };

export async function requestChat(input: {
  provider: Provider;
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  key: string;
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
      ...(input.key ? { 'x-aiflux-key': input.key } : {}),
      ...(input.searchMode !== 'off' && input.searchKey ? { 'x-aiflux-search-key': input.searchKey } : {}),
      ...(input.accessCode ? { 'x-aiflux-access-code': input.accessCode } : {}),
    },
    body: JSON.stringify({ provider: input.provider, model: input.model, messages: input.messages, searchMode: input.searchMode }),
    signal: input.signal,
  });
  if (!response.ok) {
    // A gateway timeout returns an HTML error page, not our JSON envelope.
    const json = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json().catch(() => null)
      : null;
    const detail = json && typeof json.error === 'string' ? json.error : '';
    if (response.status === 504) {
      throw new Error(detail || 'The server ran out of time before the answer finished. Try a shorter request, or host AIFLUX somewhere with a longer request limit.');
    }
    if (response.status === 502 || response.status === 503) {
      throw new Error(detail || 'The server could not complete this request. Check the deployment logs and try again.');
    }
    throw new Error(detail || `Request failed (${response.status}).`);
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
    if (!finished && !input.signal.aborted) throw new Error('The answer was cut off before it finished. A hosted deployment may have hit its request time limit — try a shorter request.');
  } finally {
    reader.releaseLock();
  }
}
