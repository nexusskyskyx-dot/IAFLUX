import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import app from './api-app.mjs';
import { PROVIDER_URLS } from './providers.mjs';

const payload = {
  provider: 'openrouter',
  model: 'poolside/laguna-s-2.1:free',
  messages: [{ role: 'user', content: 'Build a responsive landing page' }],
};

test('OpenRouter stream refuses classifier output while accepting a named chat model', async () => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fetchNetwork = globalThis.fetch;
  let upstreamModel = 'nvidia/nemotron-3.5-content-safety:free';
  let upstreamRequest;
  globalThis.fetch = (url, options) => {
    if (url !== PROVIDER_URLS.openrouter) return fetchNetwork(url, options);
    upstreamRequest = JSON.parse(options.body);
    const data = JSON.stringify({ model: upstreamModel, choices: [{ delta: { content: upstreamModel.includes('safety') ? 'User Safety: safe' : 'Here is your website.' } }] });
    return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));
  };
  try {
    const post = () => fetchNetwork(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aiflux-keys': encodeURIComponent(JSON.stringify({ openrouter: 'test-key', gemini: '', groq: '' })), ...(process.env.AIFLUX_ACCESS_CODE ? { 'x-aiflux-access-code': process.env.AIFLUX_ACCESS_CODE } : {}) },
      body: JSON.stringify(payload),
    });
    const rejected = await post();
    assert.equal(rejected.status, 200);
    const events = (await rejected.text()).trim().split('\n\n').map((line) => JSON.parse(line.replace(/^data: /, '')));
    assert.deepEqual(events.map((event) => event.type), ['start', 'error']);
    assert.match(events[1].message, /safety or utility model/);
    assert.equal(upstreamRequest.model, 'poolside/laguna-s-2.1:free');

    upstreamModel = 'poolside/laguna-s-2.1';
    const accepted = await post();
    assert.equal(accepted.status, 200);
    const chatEvents = (await accepted.text()).trim().split('\n\n').map((line) => JSON.parse(line.replace(/^data: /, '')));
    assert.deepEqual(chatEvents.map((event) => event.type), ['start', 'model', 'delta', 'done']);
    assert.equal(chatEvents[2].text, 'Here is your website.');
  } finally {
    globalThis.fetch = fetchNetwork;
    await new Promise((resolve) => server.close(resolve));
  }
});
