import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal TS → ESM shim so Node can execute tool-use via the experimental
// strip-types loader. These tests exercise parsing, snapshot injection, and
// every executor without booting the full app.

const base = await import('./tool-use.ts');
const {
  extractToolCalls, stripToolCalls, workspaceContext, buildProviderMessages,
  executeToolCall, MAX_TOOL_ROUNDS,
} = base;

function file(name, content, origin = 'starter') {
  return { id: `${name}-id`, name, content, origin };
}

test('extractToolCalls parses af-tool XML blocks with arg children', () => {
  const text = 'Planning.\n<af-tool name="write_file" id="t3"><arg name="filename">index.html</arg><arg name="content"><h1>Hi</h1></arg></af-tool>\nDone.';
  const calls = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write_file');
  assert.equal(calls[0].id, 't3');
  assert.equal(calls[0].args.filename, 'index.html');
  assert.equal(calls[0].args.content, '<h1>Hi</h1>');
});

test('extractToolCalls supports attribute shorthand for simple args', () => {
  const calls = extractToolCalls('<af-tool name="delete_file" id="x" filename="old.js"></af-tool>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'delete_file');
  assert.equal(calls[0].args.filename, 'old.js');
});

test('stripToolCalls removes raw XML from rendered assistant text', () => {
  const cleaned = stripToolCalls('Intro.\n<af-tool name="list_files" id="a"></af-tool>\nProse.');
  assert.equal(cleaned, 'Intro.\n\nProse.');
});

test('tool calls inside fenced code samples are not executed or stripped', () => {
  const sample = 'Use this format:\n```xml\n<af-tool name="list_files" id="x"></af-tool>\n```\nThen I will run it.';
  assert.equal(extractToolCalls(sample).length, 0);
  assert.match(stripToolCalls(sample), /<af-tool/);
});

test('workspaceContext reports empty canvas and file list', () => {
  assert.match(workspaceContext([]), /Canvas is currently empty/);
  const list = workspaceContext([file('index.html', '<html/>'), file('style.css', 'body{}')]);
  assert.match(list, /index.html/);
  assert.match(list, /style\.css/);
});

test('list_files returns a numbered inventory', () => {
  const r = executeToolCall({ id: '1', name: 'list_files', args: {} }, {
    files: [file('a.html', 'x'), file('b.js', 'y')], selectedFileId: null,
  });
  assert.ok(r.ok);
  assert.match(r.output, /a\.html/);
  assert.match(r.output, /b\.js/);
});

test('read_file returns file content and errors on unknown names', () => {
  const ctx = { files: [file('a.txt', 'hello world')], selectedFileId: null };
  assert.ok(executeToolCall({ id: '1', name: 'read_file', args: { filename: 'a.txt' } }, ctx).ok);
  const miss = executeToolCall({ id: '1', name: 'read_file', args: { filename: 'missing.txt' } }, ctx);
  assert.equal(miss.ok, false);
});

test('write_file creates new files and replaces existing ones', () => {
  let ctx = { files: [], selectedFileId: null };
  const created = executeToolCall({ id: '1', name: 'write_file', args: { filename: 'index.html', content: '<h1>x</h1>' } }, ctx);
  assert.ok(created.ok);
  assert.equal(created.files.length, 1);
  assert.equal(created.files[0].content, '<h1>x</h1>');
  ctx = { files: created.files, selectedFileId: created.selectedFileId };
  const overwritten = executeToolCall({ id: '2', name: 'write_file', args: { filename: 'index.html', content: '<h1>y</h1>' } }, ctx);
  assert.ok(overwritten.ok);
  assert.equal(overwritten.files.length, 1);
  assert.equal(overwritten.files[0].content, '<h1>y</h1>');
});

test('create_file rejects duplicates', () => {
  const ctx = { files: [file('index.html', 'x')], selectedFileId: null };
  const dup = executeToolCall({ id: '1', name: 'create_file', args: { filename: 'index.html', content: 'y' } }, ctx);
  assert.equal(dup.ok, false);
  assert.match(dup.output, /already exists/);
});

test('edit_file applies a unique replacement and rejects ambiguous matches', () => {
  const ctx = { files: [file('a.html', '<h1>Hi</h1><h1>There</h1><p>x</p>')], selectedFileId: null };
  // <h1> appears twice → ambiguous.
  const bad = executeToolCall({ id: '1', name: 'edit_file', args: { filename: 'a.html', old_value: '<h1>', new_value: '<h2>' } }, ctx);
  assert.equal(bad.ok, false);
  const ok = executeToolCall({ id: '2', name: 'edit_file', args: { filename: 'a.html', old_value: '<h1>Hi</h1>', new_value: '<h1>Hey</h1>' } }, ctx);
  assert.ok(ok);
  assert.equal(ok.files[0].content, '<h1>Hey</h1><h1>There</h1><p>x</p>');
});

test('delete_file removes files and advances selectedFileId', () => {
  const f1 = file('a.html', 'x');
  const f2 = file('b.html', 'y');
  const res = executeToolCall({ id: '1', name: 'delete_file', args: { filename: 'a.html' } }, { files: [f1, f2], selectedFileId: f1.id });
  assert.ok(res.ok);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].name, 'b.html');
  assert.equal(res.selectedFileId, f2.id);
});

test('view_preview assembles inlined HTML preview', () => {
  const ctx = {
    files: [
      file('index.html', '<!doctype html><html><head></head><body><h1>Hi</h1></body></html>'),
      file('styles.css', 'h1 { color: red; }'),
    ],
    selectedFileId: null,
  };
  const res = executeToolCall({ id: '1', name: 'view_preview', args: {} }, ctx);
  assert.ok(res.ok);
  assert.match(res.output, /Rendered preview source/);
  assert.match(res.output, /<h1>Hi<\/h1>/);
  assert.match(res.output, /color: red/);
});

test('buildProviderMessages injects a workspace snapshot onto the last user turn', () => {
  const fakeMessages = [
    { id: 'u1', role: 'user', content: 'build me a site', createdAt: 0 },
  ];
  // buildProviderMessages takes ChatMessages; cheat with a minimal cast.
  const msgs = buildProviderMessages(fakeMessages, [file('index.html', 'x')]);
  const last = msgs.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /<canvas-workspace>/);
  assert.match(last.content, /index\.html/);
});

test('tool loop safety cap is a positive integer', () => {
  assert.ok(Number.isInteger(MAX_TOOL_ROUNDS) && MAX_TOOL_ROUNDS >= 3 && MAX_TOOL_ROUNDS <= 16);
});
