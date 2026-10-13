import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarkdown } from './normalize-markdown.ts';

test('decodes HTML entities models overuse', () => {
  assert.equal(normalizeMarkdown('a &amp; b'), 'a & b');
  assert.equal(normalizeMarkdown('&lt;br&gt;'), '<br>');
  assert.equal(normalizeMarkdown('&nbsp;hi&nbsp;'), 'hi');
  assert.equal(normalizeMarkdown('&#8212;'), '—');
  assert.equal(normalizeMarkdown('&#x2713;'), '✓');
});

test('converts <br> and <br/> to real newlines', () => {
  assert.match(normalizeMarkdown('a<br>b<br/>c'), /a\nb\nc/);
});

test('converts <strong>, <b>, <em>, <i>, <code> to markdown equivalents', () => {
  assert.match(normalizeMarkdown('<b>x</b>'), /\*\*x\*\*/);
  assert.match(normalizeMarkdown('<strong>y</strong>'), /\*\*y\*\*/);
  assert.match(normalizeMarkdown('<em>z</em>'), /\*z\*/);
  assert.match(normalizeMarkdown('click <code>run</code> now'), /`run`/);
});

test('converts anchor tags to markdown links', () => {
  const md = normalizeMarkdown('see <a href="https://example.com">Example</a>');
  assert.match(md, /\[Example\]\(https:\/\/example\.com\)/);
});

test('normalizes unicode asterisks so bold actually renders', () => {
  // GPT-OSS and friends sometimes emit fullwidth asterisks.
  const md = normalizeMarkdown('look ＊＊bold＊＊ renders');
  assert.match(md, /\*\*bold\*\*/);
});

test('strips bidi and zero-width invisible characters', () => {
  const md = normalizeMarkdown('hi\u200B\u200D\u200Fthere');
  assert.equal(md, 'hithere');
});

test('adds a required space after heading markers', () => {
  assert.match(normalizeMarkdown('#Heading'), /# Heading/);
  assert.match(normalizeMarkdown('##Sub'), /## Sub/);
});

test('adds a space after list markers', () => {
  assert.match(normalizeMarkdown('-item'), /- item/);
  assert.match(normalizeMarkdown('*one'), /\* one/);
  assert.match(normalizeMarkdown('1.first'), /1\. first/);
});

test('converts <hr> to thematic break', () => {
  assert.match(normalizeMarkdown('a<hr>b'), /---/);
});

test('drops unknown tags but keeps their inner text', () => {
  assert.equal(normalizeMarkdown('<span>hello</span>'), 'hello');
});

test('self-closing unknown void tags are removed cleanly', () => {
  assert.equal(normalizeMarkdown('a<img src="x"/>b'), 'ab');
});

test('already-valid markdown is preserved', () => {
  const src = '## Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n> quoted\n';
  assert.equal(normalizeMarkdown(src), src.trim());
});

test('table pipes written as fullwidth are normalized so GFM tables render', () => {
  const md = normalizeMarkdown('| A｜B |\n|---｜---|\n|1｜2|');
  assert.ok(md.includes('| A|B |'), md);
  assert.ok(md.includes('|1|2|'), md);
});
