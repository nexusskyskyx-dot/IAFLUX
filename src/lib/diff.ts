export type DiffKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffResult {
  lines: DiffLine[];
  simplified: boolean;
}

const MAX_LCS_CELLS = 1_500_000;

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, '\n').split('\n');
}

function fallbackDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;

  const lines: DiffLine[] = [];
  for (let index = 0; index < prefix; index++) {
    lines.push({ kind: 'context', text: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < before.length - suffix; index++) {
    lines.push({ kind: 'removed', text: before[index], oldLine: index + 1, newLine: null });
  }
  for (let index = prefix; index < after.length - suffix; index++) {
    lines.push({ kind: 'added', text: after[index], oldLine: null, newLine: index + 1 });
  }
  for (let offset = suffix; offset > 0; offset--) {
    const oldIndex = before.length - offset;
    const newIndex = after.length - offset;
    lines.push({ kind: 'context', text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }
  return lines;
}

/** Line-based LCS diff with a bounded-memory fallback for very large files. */
export function diffLines(beforeText: string, afterText: string): DiffResult {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > MAX_LCS_CELLS) return { lines: fallbackDiff(before, after), simplified: true };

  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = before[oldIndex] === after[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      lines.push({ kind: 'context', text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex++;
      newIndex++;
    } else if (oldIndex < before.length &&
      (newIndex === after.length || table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])) {
      lines.push({ kind: 'removed', text: before[oldIndex], oldLine: oldIndex + 1, newLine: null });
      oldIndex++;
    } else {
      lines.push({ kind: 'added', text: after[newIndex], oldLine: null, newLine: newIndex + 1 });
      newIndex++;
    }
  }
  return { lines, simplified: false };
}

export interface DiffHunk {
  start: number;
  end: number;
}

export function diffHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.flatMap((line, index) => line.kind === 'context' ? [] : [index]);
  const hunks: DiffHunk[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const previous = hunks.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else hunks.push({ start, end });
  }
  return hunks;
}
