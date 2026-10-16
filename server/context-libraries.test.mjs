import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextLibraryPrompt, CONTEXT_LIBRARY_NAMES, selectContextLibraries,
} from './context-libraries.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';
import { buildRequest, validateChat } from './providers.mjs';

const models = {
  gemini: 'gemini-2.5-flash',
  openrouter: 'poolside/laguna-s-2.1:free',
  groq: 'openai/gpt-oss-120b',
  xkiro: 'mistralai/ministral-14b',
  ollama: 'qwen3:latest',
};
const xkiroFreeModelIds = new Set([models.xkiro]);

function promptFor(provider, message) {
  const input = validateChat({
    provider,
    model: models[provider],
    searchMode: 'auto',
    messages: [{ role: 'user', content: message }],
  }, provider === 'ollama', xkiroFreeModelIds);
  const request = buildRequest(input, 'test-key', 'http://127.0.0.1:11434');
  const body = JSON.parse(request.options.body);
  return body.systemInstruction?.parts?.[0]?.text ?? body.messages[0].content;
}

test('Context+ selects focused packs for design, coding, reasoning, writing, accessibility, and research', () => {
  const design = selectContextLibraries('Give me web design inspiration for a responsive landing page.');
  assert.ok(design.some(({ id }) => id === 'web-design'));
  assert.ok(design.some(({ id }) => id === 'accessibility'));

  const frontend = selectContextLibraries('Compare current React and Tailwind component libraries.');
  assert.ok(frontend.some(({ id }) => id === 'frontend-libraries'));
  assert.ok(frontend.some(({ id }) => id === 'coding-practice'));
  assert.ok(frontend.some(({ id }) => id === 'reasoning'));
  assert.ok(frontend.some(({ id }) => id === 'product-research'));

  const writing = selectContextLibraries('Help me write a thoughtful reply to this message.');
  assert.ok(writing.some(({ id }) => id === 'conversation-writing'));

  const reasoning = selectContextLibraries('Analyze the trade-offs and explain your approach.');
  assert.ok(reasoning.some(({ id }) => id === 'reasoning'));

  const backend = selectContextLibraries('Build a Python FastAPI backend and add tests with security in mind.');
  assert.ok(backend.some(({ id }) => id === 'backend-libraries'));
  assert.ok(backend.some(({ id }) => id === 'testing'));
  assert.ok(backend.some(({ id }) => id === 'security'));
  assert.ok(backend.some(({ id }) => id === 'coding-practice'));
});

test('Context+ notes are curated, bounded prompt guidance rather than inserted user/file/search contents', () => {
  const prompt = buildContextLibraryPrompt([
    'What frontend libraries are trending?',
    '```text\nSECRET_PROJECT_CODE should not be copied into the system prompt\n```',
    '<untrusted_web_search_data>SECRET_SEARCH_SNIPPET</untrusted_web_search_data>',
    'Attached file: private.ts\nSECRET_ATTACHMENT',
  ].join('\n\n'));
  assert.match(prompt, /Context\+ is a small, curated prompt library/);
  assert.match(prompt, /Frontend and component libraries/);
  assert.match(prompt, /Library and product research/);
  assert.doesNotMatch(prompt, /SECRET_(?:PROJECT_CODE|SEARCH_SNIPPET|ATTACHMENT)/);
  assert.match(prompt, /not a popularity ranking/);
});

test('a direct library-catalog request exposes the available pack names', () => {
  assert.ok(CONTEXT_LIBRARY_NAMES.length >= 10);
  const selected = selectContextLibraries('What is in the Context+ library?');
  assert.deepEqual(selected.map(({ name }) => name), [...CONTEXT_LIBRARY_NAMES]);
});

test('Context+ is present for every provider and adds request-matched notes to each provider prompt', () => {
  const message = 'Compare current React component libraries for an accessible web design.';
  for (const provider of Object.keys(models)) {
    const prompt = promptFor(provider, message);
    assert.match(prompt, /AIFLUX Context\+ reference library:/, provider);
    assert.match(prompt, /Frontend and component libraries/, provider);
    assert.match(prompt, /Web design inspiration/, provider);
    assert.match(prompt, /Accessibility and inclusive design/, provider);
    assert.match(prompt, /Library and product research/, provider);
  }

  const general = buildAssistantPrompt({ latestUserMessage: 'What is two plus two?' });
  assert.match(general, /AIFLUX Context\+ reference library:/);
  assert.doesNotMatch(general, /Relevant context packs selected for this message/);
});
