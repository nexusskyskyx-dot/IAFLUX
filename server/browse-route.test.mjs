import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// The route is reachable from the internet, so the tests here concentrate on
// what it refuses. Every case below is decided before any request leaves the
// server, which keeps them fast and independent of the outside world.
const { default: app } = await import('./api-app.mjs');
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function postBrowse(body) {
  const response = await fetch(`${base}/api/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

test('a request with no URL is rejected', async () => {
  for (const body of [{}, { url: '' }, { url: '   ' }, { url: 42 }, { url: null }]) {
    const { status } = await postBrowse(body);
    assert.equal(status, 400, JSON.stringify(body));
  }
});

test('an unreasonably long URL is rejected', async () => {
  const { status } = await postBrowse({ url: `https://example.com/${'a'.repeat(3_000)}` });
  assert.equal(status, 400);
});

test('non-web schemes are rejected', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)']) {
    const { status } = await postBrowse({ url });
    assert.equal(status, 400, url);
  }
});

test('private and metadata addresses are refused through the route', async () => {
  for (const url of [
    'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/', 'http://192.168.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
  ]) {
    const { status, json } = await postBrowse({ url });
    assert.equal(status, 422, url);
    assert.equal(json.code, 'blocked_host', url);
  }
});

test('a host that does not resolve is reported, not thrown', async () => {
  // example.invalid is reserved by RFC 2606 and can never resolve.
  const { status, json } = await postBrowse({ url: 'https://example.invalid/page' });
  assert.equal(status, 422);
  assert.equal(json.code, 'dns_failed');
  assert.match(json.error, /example\.invalid/);
});

test('a refused page comes back as a result the model can learn from, not a 500', async () => {
  const { status, json } = await postBrowse({ url: 'http://169.254.169.254/' });
  assert.equal(status, 422);
  assert.equal(typeof json.error, 'string');
  assert.ok(json.error.length > 0, 'with a message the model can repeat to the user');
});

test('browsing is rate limited separately from chatting', async () => {
  // 20 is the allowance; the route increments before it checks, so the 21st in
  // the same window is refused. Earlier tests already used part of the budget.
  let last = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await postBrowse({ url: 'http://127.0.0.1/' });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'eventually the workspace is asked to slow down');
  assert.match(last.json.error, /Too many pages/);
});

test('GET is not a browse route', async () => {
  const response = await fetch(`${base}/api/browse`);
  assert.equal(response.status, 404);
});
