export type DiffLine = {
  kind: 'context' | 'add' | 'remove' | 'skip';
  text: string;
  /** 1-based line numbers in the old and new files, for the gutter. */
  before?: number;
  after?: number;
};

/** Beyond this the DP table stops being worth the memory; fall back to a coarse diff. */
const MAX_CELLS = 900_000;

/** Longest-common-subsequence walk over the changed region. */
function lcsOps(a: string[], b: string[]): { kind: 'context' | 'add' | 'remove'; text: string }[] {
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: { kind: 'context' | 'add' | 'remove'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: 'context', text: a[i] }); i += 1; j += 1; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ kind: 'remove', text: a[i] }); i += 1; }
    else { ops.push({ kind: 'add', text: b[j] }); j += 1; }
  }
  while (i < a.length) { ops.push({ kind: 'remove', text: a[i] }); i += 1; }
  while (j < b.length) { ops.push({ kind: 'add', text: b[j] }); j += 1; }
  return ops;
}

/**
 * Unified line diff. Identical leading and trailing lines are trimmed before
 * the quadratic step, which keeps ordinary edits cheap on large files.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  // An empty file is zero lines; `''.split('\n')` would report one blank line.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (before === after) return a.map((text, index) => ({ kind: 'context' as const, text, before: index + 1, after: index + 1 }));

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA -= 1; tailB -= 1; }

  const middleA = a.slice(head, tailA);
  const middleB = b.slice(head, tailB);
  const middle = (middleA.length + 1) * (middleB.length + 1) > MAX_CELLS
    ? [...middleA.map((text) => ({ kind: 'remove' as const, text })), ...middleB.map((text) => ({ kind: 'add' as const, text }))]
    : lcsOps(middleA, middleB);

  const lines: DiffLine[] = [];
  let beforeNo = 0;
  let afterNo = 0;
  const push = (kind: DiffLine['kind'], text: string) => {
    if (kind === 'add') { afterNo += 1; lines.push({ kind, text, after: afterNo }); }
    else if (kind === 'remove') { beforeNo += 1; lines.push({ kind, text, before: beforeNo }); }
    else if (kind === 'context') { beforeNo += 1; afterNo += 1; lines.push({ kind, text, before: beforeNo, after: afterNo }); }
    else lines.push({ kind, text });
  };

  // Unchanged head, collapsed when it is long.
  if (head > context) {
    lines.push({ kind: 'skip', text: `⋯ ${head - context} unchanged ${head - context === 1 ? 'line' : 'lines'}` });
    beforeNo = head - context;
    afterNo = head - context;
  }
  for (let index = head - (head > context ? context : head); index < head; index += 1) push('context', a[index]);

  // Changed region, with long unchanged runs collapsed.
  let run: string[] = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length <= context * 2 + 1) { for (const text of run) push('context', text); }
    else {
      for (let index = 0; index < context; index += 1) push('context', run[index]);
      lines.push({ kind: 'skip', text: `⋯ ${run.length - context * 2} unchanged ${run.length - context * 2 === 1 ? 'line' : 'lines'}` });
      beforeNo += run.length - context * 2;
      afterNo += run.length - context * 2;
      for (let index = run.length - context; index < run.length; index += 1) push('context', run[index]);
    }
    run = [];
  };
  for (const op of middle) {
    if (op.kind === 'context') run.push(op.text);
    else { flushRun(); push(op.kind, op.text); }
  }
  flushRun();

  // Unchanged tail, collapsed when it is long.
  const tailCount = a.length - tailA;
  for (let index = tailA; index < tailA + Math.min(tailCount, context); index += 1) push('context', a[index]);
  if (tailCount > context) lines.push({ kind: 'skip', text: `⋯ ${tailCount - context} unchanged ${tailCount - context === 1 ? 'line' : 'lines'}` });

  return lines;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(before, after, 0)) {
    if (line.kind === 'add') added += 1;
    if (line.kind === 'remove') removed += 1;
  }
  return { added, removed };
}
