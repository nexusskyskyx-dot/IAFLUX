import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
const { default: discoverHandler } = await import('../api/models/discover.js');
const nativeFetch = globalThis.fetch;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function withDiscoveryServer(mockUpstream, run) {
  const server = createServer((req, res) => discoverHandler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  globalThis.fetch = mockUpstream;
  const post = (body) => nativeFetch(`http://127.0.0.1:${server.address().port}/api/models/discover`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try { await run(post); }
  finally {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('model discovery endpoint uses only fixed provider hosts and never returns the API key', async () => {
  const requests = [];
  await withDiscoveryServer(async (url, options) => {
    requests.push({ url: String(url), headers: options.headers });
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) return json({ models: [
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.9-pro-experimental', displayName: 'Gemini 3.9 Pro', supportedGenerationMethods: ['generateContent'] },
    ] });
    return json({}, 404);
  }, async (post) => {
    const result = await post({ provider: 'gemini', key: 'personal-gemini-secret' });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.provider, 'gemini');
    assert.deepEqual(body.models.map((model) => model.id), ['gemini-3.8-flash', 'gemini-3.9-pro-experimental']);
    assert.equal(body.models[0].badge, 'BEST OVERALL');
    assert.equal(body.models[1].badge, 'CHECK PRICING');
    assert.doesNotMatch(JSON.stringify(body), /personal-gemini-secret/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['x-goog-api-key'], 'personal-gemini-secret');
    assert.match(requests[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);

    const invalid = await post({ provider: 'https://attacker.example', key: 'secret' });
    assert.equal(invalid.status, 400);
    assert.equal(requests.length, 1);
  });
});
