import test from 'node:test';
import assert from 'node:assert/strict';
import { requestChat } from './chat.ts';

const args = (events, extras = {}) => ({
  provider: 'gemini', model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'What is new this week?' }],
  keys: { openrouter: 'or-key', gemini: 'model-key', groq: 'groq-key' }, searchKey: 'search-key', searchMode: 'always', accessCode: 'workspace-code',
  signal: new AbortController().signal, onEvent: (event) => events.push(event), ...extras,
});
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const sse = (...chunks) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { headers: { 'Content-Type': 'text/event-stream' } });

test('client forwards web preference and optional search key, then reads interleaved search and answer SSE events', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, options };
    return sse(
      frame({ type: 'start', model: 'gemini-2.5-flash' }) + 'data: {"type":"search","phase":"planning"}\n\n',
      'data: {"type":"search","phase":"searching","query":"React release"}\n\ndata: {"type":"sources","query":"React release","sources":[{"title":"React","url":"https://react.dev","snippet":"Latest"}]}\n\n',
      frame({ type: 'delta', text: 'From [1](https://react.dev).' }) + frame({ type: 'done', model: 'gemini-2.5-flash' }),
    );
  };
  try {
    await requestChat(args(events));
    assert.equal(sent.url, '/api/chat');
    assert.deepEqual(JSON.parse(decodeURIComponent(sent.options.headers['x-aiflux-keys'])), { openrouter: 'or-key', gemini: 'model-key', groq: 'groq-key' });
    assert.equal(sent.options.headers['x-aiflux-search-key'], 'search-key');
    assert.equal(sent.options.headers['x-aiflux-access-code'], 'workspace-code');
    assert.equal(JSON.parse(sent.options.body).searchMode, 'always');
    assert.deepEqual(events.map((event) => event.type), ['start', 'search', 'search', 'sources', 'delta', 'done']);
    assert.equal(events[3].sources[0].url, 'https://react.dev');
  } finally { globalThis.fetch = originalFetch; }
});

test('search off does not transmit the stored Tavily key', async () => {
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_url, options) => {
    headers = options.headers;
    return sse(frame({ type: 'start', model: 'gemini-2.5-flash' }) + frame({ type: 'done', model: 'gemini-2.5-flash' }));
  };
  try {
    await requestChat(args([], { searchMode: 'off' }));
    assert.equal(headers['x-aiflux-search-key'], undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('search failures and interrupted streams are surfaced rather than silently accepted', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => sse(frame({ type: 'search', phase: 'searching', query: 'query' }) + frame({ type: 'error', message: 'Search is unavailable.' }));
    const events = [];
    await assert.rejects(requestChat(args(events)), /Search is unavailable/);
    assert.deepEqual(events.map((event) => event.type), ['search', 'error']);
    globalThis.fetch = async () => sse(frame({ type: 'start', model: 'gemini-2.5-flash' }));
    await assert.rejects(requestChat(args([])), /connection closed before the answer finished/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Missing provider key.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(requestChat(args([])), /Missing provider key/);
  } finally { globalThis.fetch = originalFetch; }
});
