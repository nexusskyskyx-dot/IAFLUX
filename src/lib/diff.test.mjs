import test from 'node:test';
import assert from 'node:assert/strict';
import { diffHunks, diffLines } from './diff.ts';

test('line diff clearly marks insertions green candidates and deletions red candidates with line numbers', () => {
  const result = diffLines('one\ntwo\nold', 'one\ntwo\nnew');
  assert.equal(result.simplified, false);
  assert.deepEqual(result.lines.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })), [
    { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
    { kind: 'context', text: 'two', oldLine: 2, newLine: 2 },
    { kind: 'removed', text: 'old', oldLine: 3, newLine: null },
    { kind: 'added', text: 'new', oldLine: null, newLine: 3 },
  ]);
});

test('line diff handles insertion, deletion, and a brand-new empty-baseline file', () => {
  const inserted = diffLines('before\nafter', 'before\nnew line\nafter');
  assert.deepEqual(inserted.lines.map(({ kind, text }) => [kind, text]), [
    ['context', 'before'], ['added', 'new line'], ['context', 'after'],
  ]);
  const deleted = diffLines('keep\nremove me', 'keep');
  assert.deepEqual(deleted.lines.map(({ kind, text }) => [kind, text]), [
    ['context', 'keep'], ['removed', 'remove me'],
  ]);
  assert.deepEqual(diffLines('', 'new file').lines.map(({ kind, text }) => [kind, text]), [['added', 'new file']]);
});

test('diff hunks keep a small context around changes and merge nearby changes', () => {
  const lines = diffLines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nC\nd\ne\nF\ng\nh').lines;
  assert.deepEqual(diffHunks(lines, 1), [{ start: 1, end: 9 }]);
  assert.deepEqual(diffHunks(diffLines('same', 'same').lines), []);
});

test('very large diffs use a bounded-memory simplified replacement diff', () => {
  const before = Array.from({ length: 1_300 }, (_, index) => `old-${index}`).join('\n');
  const after = Array.from({ length: 1_300 }, (_, index) => `new-${index}`).join('\n');
  const result = diffLines(before, after);
  assert.equal(result.simplified, true);
  assert.equal(result.lines.filter(({ kind }) => kind === 'removed').length, 1_300);
  assert.equal(result.lines.filter(({ kind }) => kind === 'added').length, 1_300);
});
