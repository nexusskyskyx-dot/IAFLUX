import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// The ceiling the platform actually enforces. The request budget must stay
// under it, or the function is killed mid-stream and the answer is lost.
const { maxDuration } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).functions['api/*.js'];

// The shared app reads VERCEL / AIFLUX_REQUEST_TIMEOUT_MS once at import, so load
// isolated copies with a cache-busting query instead of mutating one instance.
const savedVercel = process.env.VERCEL;
const savedTimeout = process.env.AIFLUX_REQUEST_TIMEOUT_MS;
delete process.env.VERCEL;
delete process.env.AIFLUX_REQUEST_TIMEOUT_MS;
const selfHosted = await import('../server/api-app.mjs');

process.env.VERCEL = '1';
const hosted = await import('../server/api-app.mjs?hosted=1');

process.env.AIFLUX_REQUEST_TIMEOUT_MS = '9000';
const custom = await import('../server/api-app.mjs?custom=1');

delete process.env.VERCEL;
delete process.env.AIFLUX_REQUEST_TIMEOUT_MS;
if (savedVercel !== undefined) process.env.VERCEL = savedVercel;
if (savedTimeout !== undefined) process.env.AIFLUX_REQUEST_TIMEOUT_MS = savedTimeout;

test('hosted deployments stay inside the platform function budget', () => {
  assert.equal(selfHosted.REQUEST_TIMEOUT_MS, 120_000, 'self-hosted keeps the long default');
  assert.ok(maxDuration > 60, 'the function budget is raised above the old default so long code is not cut off');
  assert.ok(hosted.REQUEST_TIMEOUT_MS < maxDuration * 1000,
    `Vercel finishes before its ${maxDuration}s maxDuration (got ${hosted.REQUEST_TIMEOUT_MS}ms)`);
  assert.equal(custom.REQUEST_TIMEOUT_MS, 9_000, 'operators can override the budget');
});

test('only the hosted app trusts the platform proxy', () => {
  assert.equal(hosted.default.get('trust proxy'), true);
  assert.equal(selfHosted.default.get('trust proxy'), false);
});

function fakeRequest({ headers = {}, ip, socket } = {}) {
  return { headers, ip, socket, get(name) { return headers[name]; } };
}

test('clientKey falls back through x-real-ip, the socket and finally "unknown"', () => {
  assert.equal(hosted.clientKey(fakeRequest({ headers: { 'x-real-ip': '203.0.113.7' }, ip: '203.0.113.7' })), '203.0.113.7');
  assert.equal(hosted.clientKey(fakeRequest({ headers: { 'x-real-ip': '203.0.113.7' } })), '203.0.113.7');
  assert.equal(hosted.clientKey(fakeRequest({ ip: '198.51.100.9' })), '198.51.100.9');
  assert.equal(hosted.clientKey(fakeRequest({ socket: { remoteAddress: '10.0.0.4' } })), '10.0.0.4');
  assert.equal(hosted.clientKey(fakeRequest()), 'unknown');
});

async function hitChat(app, forwardedFor) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
      // Rejected by validation, but only after the rate limiter records the caller.
      body: JSON.stringify({ provider: 'openrouter', model: 'openai/paid', messages: [{ role: 'user', content: 'hi' }] }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Regression: without `trust proxy`, every visitor behind Vercel shares the proxy's
// socket address, so one person's traffic would rate-limit the whole deployment.
test('visitors behind the proxy get their own rate-limit buckets', async () => {
  hosted.limits.clear();
  try {
    await hitChat(hosted.default, '203.0.113.7');
    await hitChat(hosted.default, '198.51.100.22');
    await hitChat(hosted.default, '203.0.113.7');
    assert.deepEqual([...hosted.limits.keys()].sort(), ['198.51.100.22', '203.0.113.7']);
    assert.equal(hosted.limits.get('203.0.113.7').count, 2);
    assert.equal(hosted.limits.get('198.51.100.22').count, 1);
  } finally {
    hosted.limits.clear();
  }
});

test('a direct connection still collapses to one bucket when the proxy is not trusted', async () => {
  selfHosted.limits.clear();
  try {
    await hitChat(selfHosted.default, '203.0.113.7');
    await hitChat(selfHosted.default, '198.51.100.22');
    assert.equal(selfHosted.limits.size, 1, 'self-hosted runs ignore a spoofed X-Forwarded-For');
  } finally {
    selfHosted.limits.clear();
  }
});
