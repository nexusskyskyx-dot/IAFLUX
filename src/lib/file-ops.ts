import type { FileOp, FileOpResult, WorkspaceFile } from '../types';
import { safeFilename } from './files.ts';
import { diffLines, diffStats } from './diff.ts';
import { newId } from './id.ts';

export type { FileOp, FileOpResult };

function failed(op: FileOp, error: string, path: string): FileOpResult {
  return { path, action: op.action, status: 'failed', added: 0, removed: 0, diff: [], error };
}

/**
 * Locates `search` inside `content`. Falls back to a whitespace-tolerant line
 * comparison, because models reliably reproduce code but not always the exact
 * leading indentation or trailing spaces.
 */
function findSpan(content: string, search: string): [number, number] | null {
  if (!search.trim()) return null;
  const direct = content.indexOf(search);
  if (direct >= 0) return [direct, direct + search.length];

  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  for (let start = 0; start + searchLines.length <= contentLines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < searchLines.length; offset += 1) {
      if (contentLines[start + offset].trim() !== searchLines[offset].trim()) { matches = false; break; }
    }
    if (!matches) continue;
    let from = 0;
    for (let index = 0; index < start; index += 1) from += contentLines[index].length + 1;
    let to = from;
    for (let index = 0; index < searchLines.length; index += 1) to += contentLines[start + index].length + 1;
    return [from, Math.max(from, to - 1)];
  }
  return null;
}

/**
 * Applies one assistant file operation to the canvas. Pure: returns the new
 * file list plus a result describing what changed, so the chat can show a
 * chip and the canvas can show the diff.
 */
export function applyFileOp(files: WorkspaceFile[], op: FileOp): { files: WorkspaceFile[]; result: FileOpResult } {
  const raw = (op.path || '').trim();
  if (!raw) return { files, result: failed(op, 'The operation had no file path.', 'unknown') };
  const path = safeFilename(raw);

  if (op.action === 'delete') {
    const target = files.find((file) => file.name === path);
    if (!target) return { files, result: failed(op, `${path} is not on the canvas.`, path) };
    return {
      files: files.filter((file) => file.id !== target.id),
      result: { path, action: 'delete', status: 'applied', added: 0, removed: diffStats(target.content, '').removed, diff: diffLines(target.content, ''), fileId: target.id },
    };
  }

  if (op.action === 'write') {
    const existing = files.find((file) => file.name === path);
    const before = existing?.content ?? '';
    const after = op.content ?? '';
    const id = existing?.id ?? newId();
    return {
      files: existing
        ? files.map((file) => (file.id === existing.id ? { ...file, content: after } : file))
        : [...files, { id, name: path, content: after, origin: 'generated' as const }],
      result: { path, action: 'write', status: 'applied', ...diffStats(before, after), diff: diffLines(before, after), fileId: id },
    };
  }

  // patch
  const existing = files.find((file) => file.name === path);
  if (!existing) return { files, result: failed(op, `There is no ${path} on the canvas to patch.`, path) };
  const hunks = op.hunks ?? [];
  if (!hunks.length) return { files, result: failed(op, `The patch for ${path} had no SEARCH/REPLACE blocks.`, path) };

  let content = existing.content;
  for (const hunk of hunks) {
    const span = findSpan(content, hunk.search);
    if (!span) return { files, result: failed(op, `Could not find the lines to change in ${path}.`, path) };
    content = content.slice(0, span[0]) + hunk.replace + content.slice(span[1]);
  }
  return {
    files: files.map((file) => (file.id === existing.id ? { ...file, content } : file)),
    result: { path, action: 'patch', status: 'applied', ...diffStats(existing.content, content), diff: diffLines(existing.content, content), fileId: existing.id },
  };
}

/**
 * Tidies the blank gaps a removed block leaves behind. Collapsing a run of
 * newlines changes nothing in rendered Markdown, but keeps the saved
 * transcript and exports clean.
 */
export function tidyProse(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Removes tagged blocks from text, leaving only prose. Used to rebuild the
 * visible message when a resumed answer repeats itself, and as a safety net so
 * a lost `file` event can never leak raw tags into the transcript.
 */
export function stripFileBlocks(text: string): string {
  let out = text.replace(/<aiflux-(write|patch)\b[^>]*>[\s\S]*?<\/aiflux-\1\s*>/gi, '');
  out = out.replace(/<aiflux-delete\b[^>]*\/>/gi, '').replace(/<aiflux-delete\b[^>]*>[\s\S]*?<\/aiflux-delete\s*>/gi, '');
  // Drop a block the stream left open: its content belongs to a file, not chat.
  const dangling = out.search(/<aiflux-(write|patch|delete)\b/i);
  if (dangling >= 0) out = out.slice(0, dangling);
  return out;
}

/** The most recent successful change to `name`, for the canvas diff view. */
export function latestChange(messages: { fileOps?: FileOpResult[] }[], name: string): FileOpResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const match = messages[index].fileOps?.find((op) => op.path === name && op.status === 'applied');
    if (match) return match;
  }
  return null;
}
