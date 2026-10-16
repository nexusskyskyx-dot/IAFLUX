import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffStats } from './diff.ts';

const kinds = (lines) => lines.map((line) => line.kind).join('');

test('identical text produces context lines and no changes', () => {
  const lines = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(kinds(lines), 'contextcontextcontext');
  assert.deepEqual(diffStats('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
});

test('a pure insertion shows only added lines', () => {
  const lines = diffLines('a\nc', 'a\nb\nc');
  assert.equal(kinds(lines), 'contextaddcontext');
  assert.equal(lines[1].text, 'b');
  assert.deepEqual(diffStats('a\nc', 'a\nb\nc'), { added: 1, removed: 0 });
});

test('a pure deletion shows only removed lines', () => {
  assert.equal(kinds(diffLines('a\nb\nc', 'a\nc')), 'contextremovecontext');
  assert.deepEqual(diffStats('a\nb\nc', 'a\nc'), { added: 0, removed: 1 });
});

test('a changed line is reported as a remove plus an add', () => {
  const lines = diffLines('a\nb\nc', 'a\nB\nc');
  assert.equal(kinds(lines), 'contextremoveaddcontext');
  assert.deepEqual(diffStats('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
});

test('gutter line numbers track the old and new files', () => {
  const lines = diffLines('a\nb\nc', 'a\nB\nc');
  const remove = lines.find((line) => line.kind === 'remove');
  const add = lines.find((line) => line.kind === 'add');
  assert.equal(remove.before, 2);
  assert.equal(remove.after, undefined);
  assert.equal(add.after, 2);
  assert.equal(add.before, undefined);
});

test('long unchanged head and tail are collapsed into skip markers', () => {
  const head = Array.from({ length: 40 }, (_, index) => `h${index}`);
  const tail = Array.from({ length: 40 }, (_, index) => `t${index}`);
  const lines = diffLines([...head, 'old', ...tail].join('\n'), [...head, 'new', ...tail].join('\n'), 2);
  const skips = lines.filter((line) => line.kind === 'skip');
  assert.equal(skips.length, 2, 'one marker before and one after the change');
  assert.match(skips[0].text, /38 unchanged lines/);
  assert.equal(lines.filter((line) => line.kind === 'remove').length, 1);
});

test('a long unchanged run inside the change region is collapsed too', () => {
  const before = ['x', ...Array.from({ length: 30 }, (_, i) => `keep${i}`), 'y'].join('\n');
  const after = ['X', ...Array.from({ length: 30 }, (_, i) => `keep${i}`), 'Y'].join('\n');
  const lines = diffLines(before, after, 2);
  assert.ok(lines.some((line) => line.kind === 'skip' && /26 unchanged lines/.test(line.text)));
  assert.equal(lines.filter((line) => line.kind === 'add').length, 2);
});

test('a short unchanged run is shown in full rather than collapsed', () => {
  const lines = diffLines('a\nb\nc', 'A\nb\nc', 2);
  assert.equal(kinds(lines), 'removeaddcontextcontext');
  assert.ok(!lines.some((line) => line.kind === 'skip'), 'nothing is collapsed');
});

test('a whole-file rewrite is still diffable', () => {
  const stats = diffStats('one\ntwo', 'three\nfour');
  assert.deepEqual(stats, { added: 2, removed: 2 });
});

test('an empty file diff reports every line as added or removed', () => {
  assert.deepEqual(diffStats('', 'a\nb'), { added: 2, removed: 0 });
  assert.deepEqual(diffStats('a\nb', ''), { added: 0, removed: 2 });
});

test('a context of zero shows only the changed lines', () => {
  const lines = diffLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), 'l0\nCHANGED\nl19', 0);
  assert.ok(!lines.some((line) => line.kind === 'context'), 'no context lines survive');
  assert.equal(lines.filter((line) => line.kind === 'add').length, 1);
});
