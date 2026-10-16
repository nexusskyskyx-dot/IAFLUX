import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Regression: a long code-generation answer used to be killed at the platform
// request limit and surface as an error, losing everything already streamed.
// A slow-but-healthy upstream must instead end with a `truncated` event, which
// tells the client the answer is resumable.

// An Ollama stand-in that answers at once and then dribbles tokens forever.
const upstream = createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3:latest' }] }));
    return;
  }
  if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  let sent = 0;
  const timer = setInterval(() => {
    res.write(`${JSON.stringify({ model: 'llama3:latest', message: { role: 'assistant', content: `line ${sent++} of a very long file\n` }, done: false })}\n`);
  }, 60);
  // Aborting the request is what the timeout does; without this the interval
  // keeps the process alive after the test ends.
  req.on('close', () => { clearInterval(timer); res.end(); });
});

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.OLLAMA_BASE_URL = base;
process.env.AIFLUX_REQUEST_TIMEOUT_MS = '5000';
const { default: app } = await import('../server/api-app.mjs?stream-timeout=1');
delete process.env.OLLAMA_BASE_URL;
delete process.env.AIFLUX_REQUEST_TIMEOUT_MS;

const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const api = `http://127.0.0.1:${server.address().port}`;

test('a slow stream that outlives the request budget ends as resumable, not as an error', async (context) => {
  context.diagnostic('runs for the full 5s minimum budget');
  const response = await fetch(`${api}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', model: 'llama3:latest', messages: [{ role: 'user', content: 'Write me a large app.' }], searchMode: 'off' }),
  });
  assert.equal(response.status, 200);

  const events = [];
  let text = '';
  for await (const line of readEvents(response.body)) {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === 'delta') text += event.text;
  }

  assert.deepEqual([...new Set(events.map((event) => event.type))], ['start', 'delta', 'truncated']);
  assert.equal(events.at(-1).reason, 'timeout');
  assert.ok(!events.some((event) => event.type === 'error'), 'a healthy stream is never reported as a failure');
  // The work already streamed is kept — that is what makes a resume possible.
  assert.match(text, /line 0 of a very long file/, 'partial output survives the cutoff');
  assert.ok(events.filter((event) => event.type === 'delta').length > 3, 'several tokens arrived before the limit');
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}
