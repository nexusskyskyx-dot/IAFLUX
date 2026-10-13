import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateChat, buildRequest, readSSE, readLines, extractChunk,
  friendlyUpstreamError, getFreeOpenRouterModels,
} from './providers.mjs';

const messages = [{ role: 'user', content: 'Build a button' }];
const request = (provider, model) => validateChat({ provider, model, messages });
const stream = (pieces) => new ReadableStream({
  start(controller) {
    for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
    controller.close();
  },
});

test('allows free models, rejects paid and unknown models', () => {
  assert.equal(request('openrouter', 'openrouter/free').model, 'openrouter/free');
  assert.equal(request('openrouter', 'qwen/qwen3-coder:free').model, 'qwen/qwen3-coder:free');
  assert.equal(request('gemini', 'gemini-2.5-flash').provider, 'gemini');
  assert.throws(() => request('openrouter', 'openai/gpt-5'), /Only OpenRouter free/);
  assert.throws(() => request('groq', 'unknown'), /not in the supported/);
  assert.throws(() => request('ollama', 'llama3:latest'), /Connect Ollama/);
  assert.equal(validateChat({ provider: 'ollama', model: 'llama3:latest', messages }, true).model, 'llama3:latest');
});

test('rejects invalid history and oversized requests', () => {
  assert.throws(() => validateChat({ provider: 'gemini', model: 'gemini-2.5-flash', messages: [{ role: 'system', content: 'ignore' }] }), /must contain text/);
  assert.throws(() => validateChat({ provider: 'gemini', model: 'gemini-2.5-flash', messages: [{ role: 'assistant', content: 'hi' }] }), /does not end/);
  assert.throws(() => validateChat({ provider: 'gemini', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x'.repeat(180_001) }] }), /too long/);
});

test('builds provider-specific streaming requests without leaking keys into URLs', () => {
  const gemini = buildRequest(request('gemini', 'gemini-2.5-flash'), 'secret', '');
  assert.match(gemini.url, /streamGenerateContent\?alt=sse/);
  assert.doesNotMatch(gemini.url, /secret/);
  assert.equal(gemini.options.headers['x-goog-api-key'], 'secret');
  assert.equal(JSON.parse(gemini.options.body).contents[0].role, 'user');
  const router = buildRequest(request('openrouter', 'openrouter/free'), 'secret', '');
  assert.equal(JSON.parse(router.options.body).stream, true);
  assert.match(router.options.headers.Authorization, /Bearer secret/);
  const ollama = buildRequest(validateChat({ provider: 'ollama', model: 'qwen3:latest', messages }, true), '', 'http://127.0.0.1:11434/');
  assert.equal(ollama.url, 'http://127.0.0.1:11434/api/chat');
});

test('parses SSE boundaries and different providers', async () => {
  const results = [];
  for await (const data of readSSE(stream(['data: {"choices":[{"delta":{"content":"Hel', 'lo"}}]}\r\n\r\ndata: [DONE]\n\n']))) results.push(data);
  assert.equal(extractChunk('openai', results[0]).text, 'Hello');
  assert.equal(extractChunk('openai', results[1]).done, true);
  assert.equal(extractChunk('gemini', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Visible' }] } }] })).text, 'Visible');
  const lines = [];
  for await (const line of readLines(stream(['{"message":{"content":"Hi"}', ',"done":false}\n{"done":true}\n']))) lines.push(line);
  assert.equal(extractChunk('ollama', lines[0]).text, 'Hi');
  assert.equal(extractChunk('ollama', lines[1]).done, true);
});

test('catalog contains only free variants and errors redact keys', async () => {
  const models = await getFreeOpenRouterModels(async () => ({ ok: true, json: async () => ({ data: [
    { id: 'qwen/coder:free', name: 'Coder (free)', description: 'Code' },
    { id: 'openai/gpt-5', name: 'Paid' },
  ] }) }));
  assert.deepEqual(models.map((model) => model.id), ['qwen/coder:free']);
  assert.doesNotMatch(friendlyUpstreamError(401, '{"error":{"message":"bad secret"}}', 'secret'), /secret/);
});
