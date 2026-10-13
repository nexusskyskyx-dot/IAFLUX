import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('API gates shared keys and streams a local Ollama response end to end', async (t) => {
  let upstreamBody;
  const mock = createServer(async (req, res) => {
    if (req.url !== '/api/chat') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBody = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ model: 'qwen3:latest', message: { content: 'Hello ' }, done: false }) + '\n');
    res.end(JSON.stringify({ model: 'qwen3:latest', message: { content: 'from Ollama!' }, done: true }) + '\n');
  });
  const ollamaPort = await listen(mock);
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port),
      OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
      AIFLUX_ACCESS_CODE: 'test-access',
      OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise((resolve) => mock.close(resolve));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('AIFLUX server did not start')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('AIFLUX is ready')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited early (${code})`)); });
  });

  const base = `http://127.0.0.1:${port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.requiresAccessCode, true);
  assert.equal(config.ollamaConfigured, true);
  const payload = { provider: 'ollama', model: 'qwen3:latest', messages: [{ role: 'user', content: 'Say hello' }] };
  const post = (input, access = '') => fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(access ? { 'x-aiflux-access-code': access } : {}) },
    body: JSON.stringify(input),
  });
  const forbidden = await post(payload);
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).error, /access code/);
  const paid = await post({ ...payload, provider: 'openrouter', model: 'openai/gpt-5' }, 'test-access');
  assert.equal(paid.status, 400);
  const response = await post(payload, 'test-access');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter(Boolean).map((block) => JSON.parse(block.replace(/^data: /, '')));
  assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'done']);
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Hello from Ollama!');
  assert.equal(upstreamBody.messages.at(-1).content, 'Say hello');
  assert.equal(upstreamBody.messages[0].role, 'system');
});
