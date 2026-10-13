import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Set the environment before importing the Vercel entrypoint, whose shared app
// reads operator keys once at startup. All upstream traffic is mocked below.
process.env.TAVILY_API_KEY = '';
process.env.AIFLUX_ACCESS_CODE = '';
const { default: chatHandler } = await import('../api/chat.js');
const nativeFetch = globalThis.fetch;

const body = (searchMode, question = 'What is the current React release?') => ({
  provider: 'gemini', model: 'gemini-2.5-flash', searchMode,
  messages: [{ role: 'user', content: question }],
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const stream = (text) => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const parseEvents = (text) => text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));

async function withServer(mockUpstream, run) {
  const server = createServer((req, res) => chatHandler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  globalThis.fetch = mockUpstream;
  const post = (data, headers = {}) => nativeFetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aiflux-key': 'my-gemini-key', ...headers }, body: JSON.stringify(data),
  });
  try { await run(post); }
  finally {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Vercel chat rejects invalid modes before making any upstream request', async () => {
  await withServer(() => { throw new Error('Unexpected upstream request'); }, async (post) => {
    const result = await post(body('sometimes'));
    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /valid web search mode/);
  });
});

test('search off goes straight to the selected provider with no search calls', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    return stream('A coding answer.');
  }, async (post) => {
    const result = await post(body('off'));
    assert.equal(result.status, 200);
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'delta', 'done']);
    assert.equal(events[1].text, 'A coding answer.');
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:streamGenerateContent\?alt=sse/);
  const answer = JSON.parse(calls[0].options.body);
  assert.equal(answer.contents[0].parts[0].text, 'What is the current React release?');
  assert.match(answer.systemInstruction.parts[0].text, /You are AIFLUX/);
  assert.match(answer.systemInstruction.parts[0].text, /Web mode: off.*No live search was performed/);
  assert.match(answer.systemInstruction.parts[0].text, /Canvas tools:/);
});

test('auto mode lets the model skip unnecessary search and clearly reports it', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith(':generateContent')
      ? json({ candidates: [{ content: { parts: [{ text: 'NO_SEARCH' }] } }] })
      : stream('Here is the code.');
  }, async (post) => {
    const result = await post(body('auto', 'Build a simple button'));
    assert.equal(result.status, 200);
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'search', 'search', 'delta', 'done']);
    assert.deepEqual(events.filter(({ type }) => type === 'search').map(({ phase }) => phase), ['planning', 'skipped']);
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url }) => url.includes('generativelanguage.googleapis.com')));
  const answerPrompt = JSON.parse(calls[1].options.body).systemInstruction.parts[0].text;
  assert.match(answerPrompt, /You are AIFLUX/);
  assert.match(answerPrompt, /Web mode: auto.*no live search was performed/i);
  assert.doesNotMatch(answerPrompt, /The server ran a live web search/);
});

test('always mode calls Tavily keyless, passes attributed sources to the AI, and streams source links', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(':generateContent')) return json({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'React stable release 2026' } } }] } }] });
    if (url === 'https://api.tavily.com/search') return json({ results: [{ title: 'Official React docs', url: 'https://react.dev/blog/latest', content: 'Release details', published_date: '2026-10-13' }] });
    return stream('The release is described in [1](https://react.dev/blog/latest).');
  }, async (post) => {
    const result = await post(body('always'));
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/event-stream/);
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'search', 'search', 'sources', 'delta', 'done']);
    assert.equal(events[2].query, 'React stable release 2026');
    assert.equal(events[3].sources[0].url, 'https://react.dev/blog/latest');
    assert.equal(events[3].sources[0].publishedDate, '2026-10-13');
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://api.tavily.com/search');
  assert.equal(calls[1].options.headers['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[1].options.body).query, 'React stable release 2026');
  const answer = JSON.parse(calls[2].options.body);
  assert.match(answer.systemInstruction.parts[0].text, /You are AIFLUX/);
  assert.match(answer.systemInstruction.parts[0].text, /Canvas tools:/);
  assert.match(answer.systemInstruction.parts[0].text, /The server ran a live web search/);
  assert.match(answer.systemInstruction.parts[0].text, /untrusted third-party data/);
  assert.match(answer.contents.at(-1).parts[0].text, /https:\/\/react.dev\/blog\/latest/);
  assert.match(answer.contents.at(-1).parts[0].text, /Release details/);
});

test('personal Tavily key takes precedence; a search failure streams an error without exposing the key', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(':generateContent')) return json({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'Astro documentation update' } } }] } }] });
    if (url === 'https://api.tavily.com/search') return new Response('Invalid key my-private-tavily-key', { status: 401 });
    throw new Error('Generation must not start if search failed');
  }, async (post) => {
    const result = await post(body('always'), { 'x-aiflux-search-key': 'my-private-tavily-key' });
    assert.equal(result.status, 200); // Already streaming search progress.
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'search', 'search', 'error']);
    assert.match(events.at(-1).message, /Tavily search key was rejected/);
    assert.doesNotMatch(JSON.stringify(events), /my-private-tavily-key/);
  });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer my-private-tavily-key');
  assert.equal(calls[1].options.headers['X-Tavily-Access-Mode'], undefined);
  assert.equal(calls.length, 2);
});

test('Groq falls back to a safe query when a model does not support function tools', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.tavily.com/search') return json({ results: [] });
    if (JSON.parse(options.body).stream === false) return json({ error: 'Tool calling not supported' }, 400);
    return new Response('data: {"choices":[{"delta":{"content":"I could not verify a current release."}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }, async (post) => {
    const result = await post({ provider: 'groq', model: 'openai/gpt-oss-120b', searchMode: 'auto', messages: [{ role: 'user', content: 'Find the latest Astro release' }] });
    assert.equal(result.status, 200);
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'search', 'search', 'sources', 'delta', 'done']);
    assert.deepEqual(events[3].sources, []);
    assert.equal(events[3].query, 'Find the latest Astro release');
    assert.match(events[4].text, /could not verify/);
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[1].url, 'https://api.tavily.com/search');
  assert.equal(JSON.parse(calls[2].options.body).stream, true);
});

test('always mode keeps AIFLUX identity and acknowledges when no safe search was possible', async () => {
  const calls = [];
  await withServer(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith(':generateContent')
      ? json({ error: 'Tools not supported' }, 400)
      : stream('I cannot verify current details without a safe search query.');
  }, async (post) => {
    const result = await post(body('always', 'Find latest password=private123'));
    assert.equal(result.status, 200);
    const events = parseEvents(await result.text());
    assert.deepEqual(events.map(({ type }) => type), ['start', 'search', 'search', 'delta', 'done']);
    assert.equal(events[2].phase, 'skipped');
  });
  assert.equal(calls.length, 2);
  const prompt = JSON.parse(calls[1].options.body).systemInstruction.parts[0].text;
  assert.match(prompt, /You are AIFLUX/);
  assert.match(prompt, /Web mode: always.*no safe search was performed/i);
  assert.doesNotMatch(prompt, /The server ran a live web search/);
});

test('best-effort per-IP limit caps attempts to use web search', async () => {
  await withServer(() => { throw new Error('Invalid requests should not call upstreams'); }, async (post) => {
    let limited = false;
    for (let i = 0; i < 13; i++) {
      const result = await post({ ...body('auto'), model: 'not-in-catalog' });
      if (result.status === 429) {
        assert.match((await result.json()).error, /Too many web searches/);
        limited = true;
        break;
      }
      assert.equal(result.status, 400);
    }
    assert.ok(limited, 'A search limit should be reached within 13 requests from one IP');
  });
});
