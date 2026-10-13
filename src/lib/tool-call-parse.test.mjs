import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, stripToolCalls } from './tool-use.ts';

test('parses the official <af-tool name="..."> wrapper form', () => {
  const calls = extractToolCalls('<af-tool name="read_file" id="t1"><arg name="filename">index.html</arg></af-tool>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].args.filename, 'index.html');
});

test('parses HTML-escaped tool calls (&lt;read_file&gt;) that Groq sometimes emits', () => {
  const raw = '&lt;read_file&gt;\n\n&lt;arg name="filename"&gt;index.html&lt;/arg&gt;\n\n&lt;/read_file&gt;';
  const calls = extractToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].args.filename, 'index.html');
  assert.equal(stripToolCalls(raw), '');
});

test('parses bare <read_file> tags emitted without the af-tool wrapper', () => {
  const calls = extractToolCalls('<read_file><arg name="filename">index.html</arg></read_file>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].args.filename, 'index.html');
});

test('parses self-closing shorthand like <read_file filename="x"/>', () => {
  const calls = extractToolCalls('<list_files/>\nProceeding.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_files');
});

test('does not treat af-tool mentions inside fenced code blocks as real calls', () => {
  const sample = '```xml\n<af-tool name="delete_file"><arg name="filename">x.js</arg></af-tool>\n```';
  assert.equal(extractToolCalls(sample).length, 0);
});

test('stripToolCalls removes escaped/bare/wrapped tool blocks from visible prose', () => {
  assert.equal(
    stripToolCalls('Intro\n<read_file><arg name="filename">a.html</arg></read_file>\nOutro'),
    'Intro\n\nOutro',
  );
  assert.equal(
    stripToolCalls('a &lt;write_file filename="x.js"&gt;&lt;/write_file&gt; b'),
    'a  b',
  );
});

test('stripToolCalls removes truncated/unclosed tool blocks from cut-off streams', () => {
  // Simulates a rate-limit or timeout that left a half-written af-tool block
  // with no closing tag.
  const truncated = 'Here is the page:\n\n&lt;af-tool name="write_file" id="t2"&gt;\n&lt;arg name="filename"&gt;index.html&lt;/arg&gt;\n&lt;arg name="content"&gt;&lt;!DOCTYPE html&gt;\n&lt;html&gt;&lt;body&gt;&lt;h1&gt;Hi';
  const stripped = stripToolCalls(truncated);
  assert.doesNotMatch(stripped, /af-tool|write_file|<arg|&lt;/);
  assert.match(stripped, /Here is the page/);
});
