import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import configHandler from '../api/config.js';
import chatHandler from '../api/chat.js';

// Exercise the same entrypoints Vercel invokes, without relying on Vercel credentials.
test('Vercel functions route to the shared API instead of returning SPA HTML', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/config')) return configHandler(req, res);
    if (req.url?.startsWith('/api/chat')) return chatHandler(req, res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/config?source=vercel`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const config = await response.json();
    assert.equal(typeof config.configured.openrouter, 'boolean');
    const denied = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'openai/paid', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /Only OpenRouter free models/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
