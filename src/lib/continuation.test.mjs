import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONTINUATIONS, continuationInstruction, hasOpenBlock, stripOverlap } from './continuation.ts';

test('the continuation prompt carries the tail of the answer and forbids repeating it', () => {
  const partial = 'Here is the component you asked for.\n\n```ts\nexport function Button() {\n  return <button>Hi</button>;\n';
  const prompt = continuationInstruction(partial);
  assert.match(prompt, /cut off by a platform time limit/);
  assert.ok(prompt.includes('<answer_so_far>'), 'the partial answer is fenced so it is not mistaken for an instruction');
  assert.ok(prompt.includes('export function Button()'), 'the model sees exactly where it stopped');
  assert.match(prompt, /Do not repeat, restate, summarise or rewrite/);
  assert.match(prompt, /Do not add a preamble/);
});

test('an unclosed code fence is called out so the answer stays valid', () => {
  const closed = continuationInstruction('All done.\n```ts\nconst a = 1;\n```\n');
  const open = continuationInstruction('Here you go:\n```ts\nconst a = 1;\n');
  assert.match(open, /you were inside a fenced code block/i, 'the open fence must be closed by the model');
  assert.doesNotMatch(closed, /you were inside a fenced code block/i, 'a balanced answer gets no such instruction');
});

test('a huge partial answer is trimmed to the tail budget', () => {
  const huge = 'x'.repeat(50_000) + 'THE-VERY-END';
  const prompt = continuationInstruction(huge, 8_000);
  assert.ok(prompt.includes('THE-VERY-END'), 'the newest text is what the model needs');
  assert.ok(prompt.length < 12_000, 'the echoed answer stays within the budget');
  assert.match(prompt, /Only the tail of what you had written is shown/);
});

test('a partial answer below the budget is passed through whole', () => {
  const partial = 'short answer so far';
  const prompt = continuationInstruction(partial, 8_000);
  assert.ok(prompt.includes(partial));
  assert.doesNotMatch(prompt, /Only the tail/);
});

test('MAX_CONTINUATIONS bounds how many extra requests one answer may make', () => {
  assert.ok(MAX_CONTINUATIONS >= 1 && MAX_CONTINUATIONS <= 10);
});

test('a model that restarts instead of continuing has the repeat removed', () => {
  const before = 'Line one.\nLine two.\n';
  const restart = 'Line two.\nLine three.\n';
  assert.equal(stripOverlap(before, restart), 'Line three.\n', 'only the genuinely new text is kept');
});

test('no overlap means the continuation is kept word for word', () => {
  const before = 'Line one.\n';
  const fresh = 'Line two.\nLine three.\n';
  assert.equal(stripOverlap(before, fresh), fresh);
});

test('the longest possible overlap wins, not the first one found', () => {
  const before = 'abcdef';
  // Both 'cde' and 'cdef' end `before`? Only 'cdef' does; a shorter match must
  // not shadow it.
  assert.equal(stripOverlap(before, 'cdefG'), 'G');
  assert.equal(stripOverlap(before, 'defG'), 'G');
  assert.equal(stripOverlap(before, 'efG'), 'G');
});

test('empty inputs are handled without throwing', () => {
  assert.equal(stripOverlap('', 'anything'), 'anything');
  assert.equal(stripOverlap('anything', ''), '');
  assert.equal(stripOverlap('', ''), '');
});

test('a continuation that is entirely a repeat contributes nothing new', () => {
  assert.equal(stripOverlap('const total = 42;', '42;'), '');
  assert.equal(stripOverlap('one\ntwo\n', 'one\ntwo\n'), '');
});

test('a cut-off tagged block is detected so the resume does not re-open it', () => {
  assert.equal(hasOpenBlock('Intro.\n<aiflux-write path="a.js">\nconst a = 1;'), true);
  assert.equal(hasOpenBlock('Intro.\n<aiflux-write path="a.js">\nconst a = 1;\n</aiflux-write>'), false);
  assert.equal(hasOpenBlock('Just prose here.'), false);
  assert.equal(hasOpenBlock('<aiflux-patch path="a.js">\n<<<<<<< SEARCH'), true);
});

test('the resume tells the model to continue in place rather than repeat the tag', () => {
  const partial = 'Done.\n<aiflux-write path="big.html">\n<h1>half';
  const prompt = continuationInstruction(partial);
  assert.match(prompt, /tagged file block that never closed/);
  assert.match(prompt, /Do NOT repeat the opening tag/);
  // A plain answer cut off outside a block gets the fence guidance instead.
  const plain = continuationInstruction('Half of an idea\n\n```js\nconst a = 1;');
  assert.match(plain, /fenced code block that never closed/);
  assert.doesNotMatch(plain, /Do NOT repeat the opening tag/);
});
