import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Regression: a long write that hit the request limit could never finish. The
// next attempt's parser had never seen the opening tag, so everything the
// model wrote after the cutoff was dumped into the chat as prose and the
// canvas stayed empty. The client now replays the unfinished block.

const FIRST = '<aiflux-write path="big.html">\n<h1>part one';
const SECOND = '\npart two</h1>\n</aiflux-write>';

const upstream = createServer(async (req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3:latest' }] }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const send = (text) => res.write(`${JSON.stringify({ model: 'llama3:latest', message: { role: 'assistant', content: text }, done: false })}\n`);
  // The provider never sees `resume` — it is consumed by AIFLUX. The second
  // attempt is recognisable by the continuation prompt instead.
  const isResume = parsed.messages.some((message) => message.role === 'user' && message.content.includes('cut off by a platform time limit'));
  if (!isResume) {
    // First attempt: write a chunk, then stall until the limit cuts us off.
    for (const piece of FIRST.match(/[\s\S]{1,9}/g) || []) send(piece);
    // Hold the response open; `unref` so it can never keep the process alive.
    const timer = setInterval(() => {}, 1_000);
    timer.unref?.();
    req.on('close', () => clearInterval(timer));
    return;
  }
  // Second attempt: the model carries on from where it stopped.
  for (const piece of SECOND.match(/[\s\S]{1,7}/g) || []) send(piece);
  res.write(`${JSON.stringify({ model: 'llama3:latest', message: { role: 'assistant', content: '' }, done: true })}\n`);
  res.end();
});

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.AIFLUX_REQUEST_TIMEOUT_MS = '5000';
const { default: app } = await import('../server/api-app.mjs?file-resume=1');
delete process.env.OLLAMA_BASE_URL;
delete process.env.AIFLUX_REQUEST_TIMEOUT_MS;

const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => realFetch(String(url).startsWith('http') ? url : `${base}${url}`, options);
const { requestChat } = await import('../src/lib/chat.ts');
const { continuationInstruction } = await import('../src/lib/continuation.ts');

/** Mirrors one hop of App.tsx's resume loop. */
async function attempt(resume, history) {
  const ops = [];
  let prose = '';
  const { truncated } = await requestChat({
    provider: 'ollama', model: 'llama3:latest',
    messages: history,
    key: '', searchKey: '', searchMode: 'off', accessCode: '', resume,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.type === 'delta') prose += event.text;
      if (event.type === 'file') ops.push(event);
    },
  });
  return { ops, prose, truncated };
}

test('a write cut off by the time limit is finished by the next attempt', async (context) => {
  context.diagnostic('first attempt runs for the full 5s minimum budget');
  const history = [{ role: 'user', content: 'Write a big page.' }];
  const first = await attempt(undefined, history);
  assert.equal(first.truncated, true);
  assert.equal(first.ops.length, 1);
  assert.equal(first.ops[0].status, 'incomplete');
  assert.equal(first.ops[0].path, 'big.html');
  assert.equal(first.ops[0].raw, FIRST, 'the unfinished block is handed back for resuming');
  assert.equal(first.prose, '', 'nothing partial is dumped into the chat');

  // App.tsx sends the raw stream back so the model continues inside the block.
  const rawText = first.ops[0].raw;
  const second = await attempt(rawText, [...history, { role: 'user', content: continuationInstruction(rawText) }]);
  assert.equal(second.truncated, false);
  assert.equal(second.ops.length, 1);
  assert.equal(second.ops[0].status, 'done');
  assert.equal(second.ops[0].path, 'big.html');
  // The replayed prefix plus the new tail form one complete file.
  assert.equal(second.ops[0].content, '<h1>part one\npart two</h1>');
  assert.equal(second.prose, '', 'still no code in the transcript');
});

test.after(async () => {
  // The stalled response never ends on its own, so drop it before closing.
  server.closeAllConnections?.();
  upstream.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

test('the replayed block is validated, so it cannot smuggle arbitrary text', async () => {
  const { validateChat } = await import('./providers.mjs');
  const base = { provider: 'ollama', model: 'llama3:latest', messages: [{ role: 'user', content: 'hi' }], searchMode: 'off' };
  assert.equal(validateChat({ ...base, resume: '<aiflux-write path="a.js">x' }, true).resumeBlock, '<aiflux-write path="a.js">x');
  assert.equal(validateChat({ ...base, resume: '<aiflux-patch path="a.js">x' }, true).resumeBlock, '<aiflux-patch path="a.js">x');
  for (const junk of ['not a tag', '<script>alert(1)</script>', { evil: true }, 42, '<aiflux-write>x'.repeat(90_000)]) {
    assert.equal(validateChat({ ...base, resume: junk }, true).resumeBlock, '', JSON.stringify(junk).slice(0, 40));
  }
  assert.equal(validateChat(base, true).resumeBlock, '', 'absent resume is fine');
});
