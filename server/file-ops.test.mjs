import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileOpParser, parseHunks } from './file-ops.mjs';

function collect(chunks, { finish = true } = {}) {
  const texts = [];
  const ops = [];
  const parser = createFileOpParser({ onText: (text) => texts.push(text), onOp: (op) => ops.push(op) });
  for (const chunk of chunks) parser.push(chunk);
  if (finish) parser.end();
  return { text: texts.join(''), ops };
}

test('prose around a write block reaches the chat, and the block does not', () => {
  const { text, ops } = collect(['Here you go.\n', '<aiflux-write path="index.html">\n<h1>Hi</h1>\n</aiflux-write>\n', 'Hope that helps.']);
  assert.equal(text, 'Here you go.\n\nHope that helps.');
  assert.equal(ops.length, 1);
  assert.deepEqual({ action: ops[0].action, path: ops[0].path, content: ops[0].content, status: ops[0].status },
    { action: 'write', path: 'index.html', content: '<h1>Hi</h1>', status: 'done' });
});

test('a tag split across many chunks still parses', () => {
  const whole = 'Intro. <aiflux-write path="app.js">const a = 1;</aiflux-write> Outro.';
  for (const size of [1, 3, 7, 13]) {
    const chunks = whole.match(new RegExp(`.{1,${size}}`, 'gs')) || [];
    const { text, ops } = collect(chunks);
    assert.equal(ops.length, 1, `chunk size ${size}`);
    assert.equal(ops[0].path, 'app.js', `chunk size ${size}`);
    assert.equal(ops[0].content, 'const a = 1;', `chunk size ${size}`);
    assert.equal(text, 'Intro.  Outro.', `chunk size ${size}`);
  }
});

test('a partial tag at the end of a chunk is held back, not emitted', () => {
  const parser = createFileOpParser({ onText: () => {}, onOp: () => {} });
  // Nothing should be flushed until the tag resolves one way or the other.
  const seen = [];
  const spy = createFileOpParser({ onText: (text) => seen.push(text), onOp: () => {} });
  spy.push('hello <aifl');
  assert.deepEqual(seen, ['hello '], 'the incomplete tag is buffered');
  spy.push('ux-write path="a.txt">body</aiflux-write>');
  spy.end();
  assert.deepEqual(seen, ['hello ']);
  parser.end();
});

test('text that only looks like a tag is passed through', () => {
  const { text, ops } = collect(['Use <aiflux-ish> carefully and a < b.']);
  assert.equal(text, 'Use <aiflux-ish> carefully and a < b.');
  assert.deepEqual(ops, []);
});

test('a delete block needs no closing tag', () => {
  const { text, ops } = collect(['Removing it. <aiflux-delete path="old.js" /> Done.']);
  assert.equal(text, 'Removing it.  Done.');
  assert.deepEqual(ops, [{ action: 'delete', path: 'old.js', status: 'done', raw: '<aiflux-delete path="old.js" />' }]);
});

test('patch blocks are parsed into SEARCH/REPLACE hunks', () => {
  const { ops, text } = collect([
    'Tweaking.\n',
    '<aiflux-patch path="app.js">\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n</aiflux-patch>\n',
    'Done.',
  ]);
  assert.equal(text, 'Tweaking.\n\nDone.');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].action, 'patch');
  assert.deepEqual(ops[0].hunks, [{ search: 'const a = 1;', replace: 'const a = 2;' }]);
});

test('several hunks in one patch are all kept', () => {
  const { ops } = collect(['<aiflux-patch path="a.js">\n<<<<<<< SEARCH\none\n=======\ntwo\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nthree\n=======\nfour\n>>>>>>> REPLACE\n</aiflux-patch>']);
  assert.deepEqual(ops[0].hunks, [
    { search: 'one', replace: 'two' },
    { search: 'three', replace: 'four' },
  ]);
});

test('a block the stream left open is reported as incomplete and never applied', () => {
  const { text, ops } = collect(['Almost there. <aiflux-write path="big.html">\n<h1>unfinished']);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'incomplete');
  assert.equal(ops[0].path, 'big.html');
  assert.match(ops[0].raw, /^<aiflux-write path="big\.html">/);
  assert.match(ops[0].raw, /<h1>unfinished$/);
  // The partial body is not prose: it belongs to a file, not the transcript.
  assert.equal(text, 'Almost there. ');
});

test('path attributes accept double quotes, single quotes, or none', () => {
  for (const [attrs, expected] of [['path="a.js"', 'a.js'], ["path='b.js'", 'b.js'], ['path=c.js', 'c.js'], ['PATH="d.js"', 'd.js']]) {
    const { ops } = collect([`<aiflux-write ${attrs}>x</aiflux-write>`]);
    assert.equal(ops[0]?.path, expected, attrs);
  }
});

test('a runaway block is handed back as text instead of buffering forever', () => {
  const parser = createFileOpParser({ onText: () => {}, onOp: () => {}, maxBlock: 50 });
  const ops = [];
  const texts = [];
  const spy = createFileOpParser({ onText: (text) => texts.push(text), onOp: (op) => ops.push(op), maxBlock: 50 });
  spy.push('<aiflux-write path="x.txt">' + 'y'.repeat(80));
  assert.deepEqual(ops, [], 'nothing applied');
  assert.match(texts.join(''), /^<aiflux-write path="x\.txt">y+$/, 'the raw text is returned to the chat');
  spy.end();
  parser.end();
});

test('hunks with empty search or replacement text survive parsing', () => {
  // A pure insertion: nothing to search for, new lines to add.
  const insertion = parseHunks('<<<<<<< SEARCH\n=======\nnew line\n>>>>>>> REPLACE');
  assert.deepEqual(insertion, [{ search: '', replace: 'new line' }]);
  // A pure deletion.
  assert.deepEqual(parseHunks('<<<<<<< SEARCH\ngone\n=======\n>>>>>>> REPLACE'), [{ search: 'gone', replace: '' }]);
});

test('an unterminated hunk is dropped rather than guessed at', () => {
  assert.deepEqual(parseHunks('<<<<<<< SEARCH\nunfinished\n=======\nreplacement'), []);
  assert.deepEqual(parseHunks('no markers here'), []);
});

// Models trained on other artifact formats fall back on wrapper tags we did not
// ask for. Guessing wrong here means the canvas silently does nothing.
test('a <document> block with a path is treated as a write', () => {
  const { text, ops } = collect(['Here it is.\n<document path="index.html">\n<h1>Hi</h1>\n</document>\nDone.']);
  assert.equal(text, 'Here it is.\n\nDone.');
  assert.equal(ops.length, 1);
  assert.deepEqual({ action: ops[0].action, path: ops[0].path, content: ops[0].content }, { action: 'write', path: 'index.html', content: '<h1>Hi</h1>' });
});

test('<file> and <artifact> wrappers work the same way', () => {
  for (const tag of ['file', 'artifact', 'Document', 'FILE']) {
    const { ops } = collect([`<${tag} path="a.js">const a = 1;</${tag}>`]);
    assert.equal(ops[0]?.action, 'write', tag);
    assert.equal(ops[0]?.path, 'a.js', tag);
    assert.equal(ops[0]?.content, 'const a = 1;', tag);
  }
});

test('any of path, file, filename or name names the target', () => {
  for (const attr of ['path', 'file', 'filename', 'name']) {
    const { ops } = collect([`<aiflux-write ${attr}="a.js">x</aiflux-write>`]);
    assert.equal(ops[0]?.path, 'a.js', attr);
  }
});

test('a wrapper with no path passes its content through instead of vanishing', () => {
  // Nothing is lost: the body reaches the chat, where the fenced-block
  // fallback can still turn it into a canvas file.
  const { text, ops } = collect(['Intro.\n<document>\n```html\n<h1>Hi</h1>\n```\n</document>\nOutro.']);
  assert.deepEqual(ops, []);
  assert.equal(text, 'Intro.\n\n```html\n<h1>Hi</h1>\n```\n\nOutro.');
});

test('an unclosed wrapper keeps its content but drops the tag', () => {
  // Nothing is lost, and the decorative tag never reaches the transcript.
  const { text, ops } = collect(['Intro. <document>\nstill writing']);
  assert.deepEqual(ops, []);
  assert.doesNotMatch(text, /<document>/, 'the tag never reaches the transcript');
  assert.match(text, /still writing/, 'but the content is not lost');
});

test('a bare wrapper becomes a named fenced block the client can pick up', () => {
  const { text, ops } = collect(['<document>\n<!doctype html>\n<title>Hi</title>\n</document>']);
  assert.deepEqual(ops, [], 'handled by the fenced-block fallback instead');
  assert.equal(text.trim(), '```html filename="index.html"\n<!doctype html>\n<title>Hi</title>\n```');
});

test('a bare wrapper already containing a fence is left alone', () => {
  const inner = '```html\n<h1>Hi</h1>\n```';
  const { text } = collect([`<document>\n${inner}\n</document>`]);
  assert.equal(text.trim(), inner, 'double-wrapping would mangle it');
});

test('a filename comment inside a bare wrapper names the file', () => {
  const { text } = collect(['<document>\n// src/app.js\nconst a = 1;\n</document>']);
  assert.match(text, /filename="src\/app\.js"/);
});

test('a block containing a second opening tag is refused rather than written', () => {
  const { ops } = collect(['<aiflux-write path="a.js">const a = 1;\n<aiflux-write path="a.js">const a = 1;</aiflux-write>\n</aiflux-write>']);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'invalid');
  assert.match(ops[0].error, /second opening tag/);
  assert.equal(ops[0].content, undefined, 'nothing is written');
});

test('ordinary HTML and comparison operators stay in the prose', () => {
  const prose = 'Use <div> here, check a < b and 3 < 5, then <span>ok</span>.';
  const { text, ops } = collect([prose]);
  assert.equal(text, prose);
  assert.deepEqual(ops, []);
});

// Agentic models invent tool calls to read data they were not given. AIFLUX has
// no such capability, so the invocation is dropped rather than shown to the user.
test('an invented tool call is dropped instead of reaching the chat', () => {
  const tag = '<url_fetch> https://app.aiflux.workers.dev/canvas/getFile?file=index.html </url_fetch>';
  for (const chunks of [[`Let me check.\n${tag}\nHere you go.`], tag.match(/[\s\S]{1,7}/g) || []]) {
    const { text, ops } = collect(chunks);
    assert.deepEqual(ops, [], 'no file operation is produced');
    assert.doesNotMatch(text, /url_fetch/, 'the fabricated tag is not shown');
    assert.doesNotMatch(text, /workers\.dev/, 'nor the fabricated endpoint');
  }
  assert.equal(collect(['Let me check.\n' + tag + '\nHere you go.']).text, 'Let me check.\n\nHere you go.');
});

test('other invented tool tags are dropped the same way', () => {
  for (const tag of ['url_fetch', 'read_file', 'tool_call', 'function_call', 'web_fetch', 'get_file']) {
    const { text, ops } = collect([`<${tag}>path/to/thing</${tag}>`]);
    assert.deepEqual(ops, [], tag);
    assert.equal(text, '', tag);
  }
});

test('an invented tool call that is never closed does not swallow the reply', () => {
  const { text, ops } = collect(['Before. <url_fetch> https://example.com/x']);
  assert.deepEqual(ops, []);
  assert.equal(text, 'Before. ', 'the tag is dropped; nothing after it was written');
});
