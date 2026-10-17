import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildRequest, validateChat, getFreeXkiroModels, isXkiroModelAvailable, RequestError,
} from './providers.mjs';

// xKiro is OpenAI-compatible: /v1/chat/completions with a bearer key and SSE.
const XKIRO_URL = 'https://api.xkiro.com/v1/chat/completions';
const chat = (model, content = 'Hello') => ({
  provider: 'xkiro', model, messages: [{ role: 'user', content }],
});

test('builds an OpenAI-compatible streaming request with bearer auth', () => {
  const { url, format, options } = buildRequest(chat('qwen/qwen3-coder-plus:free'), 'xk-test-key', '');
  assert.equal(url, XKIRO_URL);
  assert.equal(format, 'openai');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer xk-test-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'qwen/qwen3-coder-plus:free');
  assert.equal(body.stream, true);
  assert.equal(body.messages.at(-1).content, 'Hello');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /You are AIFLUX/);
  // The key must never appear in a URL.
  assert.doesNotMatch(url, /xk-test-key/);
});

test('requires a key before calling xKiro', () => {
  assert.throws(() => buildRequest(chat('qwen/qwen3-coder-plus:free'), '', ''), (error) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.status, 401);
    assert.match(error.message, /xKiro API key/);
    return true;
  });
});

test('accepts curated free models and rejects ids that are not vendor/model', () => {
  const accepted = validateChat(chat('qwen/qwen3-coder-plus:free'));
  assert.equal(accepted.model, 'qwen/qwen3-coder-plus:free');
  assert.equal(validateChat(chat('mistralai/codestral-2508')).model, 'mistralai/codestral-2508');

  // xKiro 404s a bare model name, so catch it before the network.
  assert.throws(() => validateChat(chat('gpt-5.6-sol')), /valid xKiro model id/);
  assert.throws(() => validateChat(chat('openai/gpt-5.6-sol/../../etc/passwd')), /valid xKiro model id/);
  assert.throws(() => validateChat(chat('qwen/qwen3-coder-plus:free extra')), /valid xKiro model id/);
});

test('rejects safety, moderation and other non-chat xKiro ids', () => {
  for (const id of ['nvidia/nemotron-content-safety', 'vendor/text-embedding-3', 'vendor/moderation']) {
    assert.throws(() => validateChat(chat(id)), /safety or utility model/, `expected ${id} to be rejected`);
  }
});

test('still enforces the shared conversation rules', () => {
  assert.throws(() => validateChat({ ...chat('qwen/qwen3.8-max:free'), searchMode: 'sometimes' }), /valid web search mode/);
  assert.throws(() => validateChat({ ...chat('qwen/qwen3.8-max:free'), messages: [] }), /1–50 messages/);
});

test('falls back to the id shape when the free catalogue has never loaded', () => {
  // Degraded mode: discovery unreachable, so requests are allowed through rather
  // than blocked, and the UI flags that availability was not verified.
  assert.equal(isXkiroModelAvailable('somevendor/some-model'), true);
  assert.equal(isXkiroModelAvailable('qwen/qwen3-coder-plus:free'), true);
});

const catalogPayload = (models) => new Response(JSON.stringify({ object: 'list', data: models }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

const entry = (id, extra = {}) => ({
  id, object: 'model', display_name: id.split('/').at(-1), owned_by: id.split('/')[0],
  access_tier: 'free', context_length: 262000, max_output_tokens: 65536,
  pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
  capabilities: { vision: false, tools: true, reasoning: true }, ...extra,
});

test('discovery keeps only free chat models and maps them for the library', async () => {
  const models = await getFreeXkiroModels(async () => catalogPayload([
    entry('qwen/qwen3-coder-plus:free', { display_name: 'Qwen3 Coder Plus', context_length: 1050000 }),
    entry('mistralai/codestral-2508', { display_name: 'Codestral' }),
    entry('deepseek/deepseek-v4-pro-0813', { access_tier: 'paid' }),
    entry('openai/gpt-6-astra', { access_tier: 'premium' }),
    entry('vendor/nemotron-content-safety', { display_name: 'Safety' }),
    entry('vendor/text-embedding-large', { display_name: 'Embeddings' }),
  ]));

  const ids = models.map((model) => model.id);
  assert.deepEqual(ids.sort(), ['mistralai/codestral-2508', 'qwen/qwen3-coder-plus:free']);
  const coder = models.find((model) => model.id === 'qwen/qwen3-coder-plus:free');
  assert.equal(coder.provider, 'xkiro');
  assert.equal(coder.name, 'Qwen3 Coder Plus');
  assert.equal(coder.shortName, 'qwen3-coder-plus');
  assert.equal(coder.badge, 'FREE MODEL');
  assert.equal(coder.strength, 'Coding focused');
  assert.equal(coder.contextLength, 1050000);
  assert.match(coder.description, /1\.05M context/);
  assert.match(coder.description, /Served by qwen/);
});

test('after discovery, only models it listed as free are selectable', () => {
  assert.equal(isXkiroModelAvailable('qwen/qwen3-coder-plus:free'), true, 'curated picks always pass');
  assert.equal(isXkiroModelAvailable('mistralai/codestral-2508'), true);
  assert.equal(isXkiroModelAvailable('deepseek/deepseek-v4-pro-0813'), false, 'paid model is refused');
  assert.equal(isXkiroModelAvailable('openai/gpt-6-astra'), false, 'premium model is refused');
});

test('discovery failures are reported, not swallowed', async () => {
  await assert.rejects(getFreeXkiroModels(async () => new Response('nope', { status: 500 })), /xKiro model catalog unavailable/);
  // `data: undefined` is dropped by JSON.stringify, leaving a body with no list.
  await assert.rejects(getFreeXkiroModels(async () => catalogPayload(undefined)), /Invalid xKiro model catalog/);
});

// End to end through the Vercel entrypoint, with the upstream mocked.
process.env.XKIRO_API_KEY = '';
process.env.AIFLUX_ACCESS_CODE = '';
process.env.XWEB_KEY = '';
const { default: chatHandler } = await import('../api/chat.js');

const nativeFetch = globalThis.fetch;
const sse = (parts) => new Response(
  parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);
const delta = (text, model = 'qwen/qwen3-coder-plus:free') => ({ choices: [{ delta: { content: text } }], model });

async function withServer(mockUpstream, run) {
  const server = createServer((req, res) => chatHandler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  globalThis.fetch = mockUpstream;
  const post = (data) => nativeFetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aiflux-key': 'xk-user-key' },
    body: JSON.stringify(data),
  });
  try { await run(post); } finally {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('streams an xKiro answer end to end through the API', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    return sse([delta('Here is '), delta('your code.')]);
  }, async (post) => {
    const result = await post(chat('qwen/qwen3-coder-plus:free', 'Build a button'));
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/event-stream/);
    const events = (await result.text()).split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));
    assert.deepEqual(events.map((e) => e.type), ['start', 'delta', 'delta', 'done']);
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Here is your code.');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, XKIRO_URL);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xk-user-key');
  assert.equal(JSON.parse(calls[0].options.body).model, 'qwen/qwen3-coder-plus:free');
});

test('a safety model answering an xKiro request stops the stream', async () => {
  await withServer(async () => sse([{ choices: [{ delta: { content: 'User Safety: safe' } }], model: 'nvidia/nemotron-content-safety' }]), async (post) => {
    const result = await post(chat('qwen/qwen3-coder-plus:free'));
    const events = (await result.text()).split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).message, /safety or utility model/);
  });
});
