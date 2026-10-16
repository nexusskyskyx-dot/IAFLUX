import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFileOp, opResultsForFiles, stripFileBlocks } from './file-ops.ts';

const file = (name, content, origin = 'generated') => ({ id: `id-${name}`, name, content, origin });

test('write creates a new file and reports the added lines', () => {
  const { files, result } = applyFileOp([], { action: 'write', path: 'index.html', content: '<h1>Hi</h1>\n<p>There</p>' });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'index.html');
  assert.equal(files[0].content, '<h1>Hi</h1>\n<p>There</p>');
  assert.equal(result.status, 'applied');
  assert.deepEqual({ added: result.added, removed: result.removed }, { added: 2, removed: 0 });
  assert.equal(result.fileId, files[0].id);
});

test('write replaces the contents of an existing file in place', () => {
  const existing = file('app.js', 'const a = 1;');
  const { files, result } = applyFileOp([existing], { action: 'write', path: 'app.js', content: 'const a = 2;\nconst b = 3;' });
  assert.equal(files.length, 1, 'no duplicate file');
  assert.equal(files[0].id, existing.id, 'the file keeps its identity');
  assert.equal(files[0].content, 'const a = 2;\nconst b = 3;');
  assert.deepEqual({ added: result.added, removed: result.removed }, { added: 2, removed: 1 });
});

test('patch changes only the targeted lines', () => {
  const existing = file('app.js', 'const a = 1;\nconst b = 2;\nconst c = 3;');
  const { files, result } = applyFileOp([existing], {
    action: 'patch', path: 'app.js',
    hunks: [{ search: 'const b = 2;', replace: 'const b = 20;' }],
  });
  assert.equal(files[0].content, 'const a = 1;\nconst b = 20;\nconst c = 3;');
  assert.deepEqual({ added: result.added, removed: result.removed }, { added: 1, removed: 1 });
});

test('patch applies every hunk in order', () => {
  const existing = file('a.js', 'one\ntwo\nthree');
  const { files } = applyFileOp([existing], {
    action: 'patch', path: 'a.js',
    hunks: [{ search: 'one', replace: '1' }, { search: 'three', replace: '3' }],
  });
  assert.equal(files[0].content, '1\ntwo\n3');
});

test('patch tolerates indentation that does not match exactly', () => {
  const existing = file('a.js', 'function f() {\n    return 1;\n}');
  // The model reproduced the code but not the leading whitespace.
  const { files, result } = applyFileOp([existing], { action: 'patch', path: 'a.js', hunks: [{ search: 'return 1;', replace: 'return 2;' }] });
  assert.equal(result.status, 'applied');
  assert.equal(files[0].content, 'function f() {\n    return 2;\n}');
});

test('insertions and deletions work through a patch', () => {
  const existing = file('a.js', 'a\nc');
  const inserted = applyFileOp([existing], { action: 'patch', path: 'a.js', hunks: [{ search: 'a', replace: 'a\nb' }] });
  assert.equal(inserted.files[0].content, 'a\nb\nc');
  const deleted = applyFileOp([existing], { action: 'patch', path: 'a.js', hunks: [{ search: 'a\nc', replace: 'a' }] });
  assert.equal(deleted.files[0].content, 'a');
});

test('a patch that matches nothing fails without touching the file', () => {
  const existing = file('app.js', 'const a = 1;');
  const { files, result } = applyFileOp([existing], { action: 'patch', path: 'app.js', hunks: [{ search: 'not in the file', replace: 'x' }] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Could not find the lines to change in app\.js/);
  assert.equal(files[0].content, 'const a = 1;', 'the file is untouched');
});

test('patching a file that does not exist fails cleanly', () => {
  const { files, result } = applyFileOp([], { action: 'patch', path: 'ghost.js', hunks: [{ search: 'a', replace: 'b' }] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /no ghost\.js on the canvas/);
  assert.deepEqual(files, []);
});

test('a patch with no hunks fails rather than silently doing nothing', () => {
  const { result } = applyFileOp([file('a.js', 'x')], { action: 'patch', path: 'a.js', hunks: [] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /no SEARCH\/REPLACE blocks/);
});

test('delete removes the file and reports the removed lines', () => {
  const existing = file('old.html', '<p>bye</p>');
  const { files, result } = applyFileOp([existing], { action: 'delete', path: 'old.html' });
  assert.deepEqual(files, []);
  assert.equal(result.status, 'applied');
  assert.equal(result.removed, 1);
});

test('deleting a missing file fails without changing anything', () => {
  const existing = file('keep.js', 'x');
  const { files, result } = applyFileOp([existing], { action: 'delete', path: 'ghost.js' });
  assert.equal(result.status, 'failed');
  assert.equal(files.length, 1);
});

test('an operation with no path fails instead of writing a placeholder file', () => {
  for (const path of ['', '   ', undefined]) {
    const { files, result } = applyFileOp([], { action: 'write', path, content: 'x' });
    assert.equal(result.status, 'failed', String(path));
    assert.deepEqual(files, []);
  }
});

test('paths are normalised so a model cannot escape the workspace', () => {
  const { files } = applyFileOp([], { action: 'write', path: '../../etc/passwd', content: 'x' });
  assert.ok(!files[0].name.includes('..'), files[0].name);
  assert.ok(files[0].name.startsWith('/') === false, files[0].name);
});

test('stripFileBlocks leaves prose and removes the tagged blocks', () => {
  const text = 'Here you go.\n<aiflux-write path="a.js">const a = 1;</aiflux-write>\nAll set.\n<aiflux-delete path="b.js" />';
  assert.equal(stripFileBlocks(text), 'Here you go.\n\nAll set.\n');
});

test('stripFileBlocks drops a block the stream left open', () => {
  assert.equal(stripFileBlocks('Intro. <aiflux-write path="a.js">\nunfinished'), 'Intro. ');
  assert.equal(stripFileBlocks('Intro. <aiflux-patch path="a.js">\n<<<<<<< SEARCH'), 'Intro. ');
});

test('stripFileBlocks leaves ordinary text alone', () => {
  const prose = 'Compare a < b and use <div> in HTML. Nothing to strip.';
  assert.equal(stripFileBlocks(prose), prose);
});

test('a named fenced block leaves the transcript once it becomes a file', async () => {
  const { stripNamedCodeBlocks } = await import('./files.ts');
  const text = 'Here you go.\n\n```html filename="index.html"\n<h1>Hi</h1>\n```\n\nAll set.';
  const stripped = stripNamedCodeBlocks(text);
  assert.doesNotMatch(stripped, /<h1>Hi<\/h1>/, 'the code does not stay in the chat');
  assert.match(stripped, /Here you go\./);
  assert.match(stripped, /All set\./);
});

test('an unnamed snippet stays in the transcript', async () => {
  const { stripNamedCodeBlocks } = await import('./files.ts');
  // A short example in an explanation is not a file; removing it would be wrong.
  const text = 'Call it like this:\n\n```js\nuseEffect(() => {}, []);\n```\n';
  assert.equal(stripNamedCodeBlocks(text), text);
});

test('fallback files get the same chip data as tagged writes', () => {
  const existing = [{ id: 'f1', name: 'app.js', content: 'const a = 1;', origin: 'generated' }];
  const generated = [{ id: 'f2', name: 'index.html', content: '<h1>Hi</h1>\n<p>There</p>', origin: 'generated' }];
  const results = opResultsForFiles(existing, generated);
  assert.equal(results.length, 1);
  assert.deepEqual({ path: results[0].path, status: results[0].status, added: results[0].added, removed: results[0].removed },
    { path: 'index.html', status: 'applied', added: 2, removed: 0 });
  assert.equal(results[0].fileId, 'f2');
  assert.ok(results[0].diff.length > 0, 'the canvas can still show a diff');
});

test('a fallback file that replaces an existing one reports the real change', () => {
  const existing = [{ id: 'f1', name: 'app.js', content: 'const a = 1;', origin: 'generated' }];
  const generated = [{ id: 'f2', name: 'app.js', content: 'const a = 2;\nconst b = 3;', origin: 'generated' }];
  const results = opResultsForFiles(existing, generated);
  assert.deepEqual({ added: results[0].added, removed: results[0].removed }, { added: 2, removed: 1 });
});
