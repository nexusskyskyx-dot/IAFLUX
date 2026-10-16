import type { Provider, SearchMode, WebSource } from '../types';

export type StreamEvent =
  | { type: 'start' | 'model' | 'done'; model: string }
  | { type: 'delta'; text: string }
  | { type: 'search'; phase: 'planning' | 'searching' | 'skipped'; query?: string }
  | { type: 'sources'; query: string; sources: WebSource[] }
  | { type: 'truncated'; reason: string }
  | {
      type: 'file';
      action: 'write' | 'patch' | 'delete';
      path: string;
      status: 'done' | 'incomplete';
      content?: string;
      hunks?: { search: string; replace: string }[];
      /** The raw tagged block, used to resume a write the time limit cut short. */
      raw?: string;
    }
  | { type: 'error'; message: string };

/**
 * Streams one request. Resolves with `truncated: true` when the server stopped
 * at its own request limit — the model was still writing, so that is resumable
 * rather than a failure, and it is reported instead of thrown.
 */
export async function requestChat(input: {
  provider: Provider;
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  key: string;
  searchKey: string;
  searchMode: SearchMode;
  /** Canvas manifest: names and line counts, so the model patches what exists. */
  canvas?: { name: string; lines: number }[];
  /** The unfinished tagged block from the previous attempt, replayed server-side. */
  resume?: string;
  accessCode: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}): Promise<{ truncated: boolean }> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(input.key ? { 'x-aiflux-key': input.key } : {}),
      ...(input.searchMode !== 'off' && input.searchKey ? { 'x-aiflux-search-key': input.searchKey } : {}),
      ...(input.accessCode ? { 'x-aiflux-access-code': input.accessCode } : {}),
    },
    body: JSON.stringify({ provider: input.provider, model: input.model, messages: input.messages, searchMode: input.searchMode, canvas: input.canvas, resume: input.resume }),
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
  let truncated = false;
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
          if (event.type === 'truncated') truncated = true;
          if (event.type === 'done') finished = true;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    // `truncated` counts as a clean ending: the server said so explicitly, and
    // the caller decides whether to pick the answer back up.
    if (!finished && !truncated && !input.signal.aborted) {
      throw new Error('The answer was cut off before it finished. A hosted deployment may have hit its request time limit — try a shorter request.');
    }
    return { truncated };
  } finally {
    reader.releaseLock();
  }
}
