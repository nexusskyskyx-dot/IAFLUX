import { useMemo } from 'react';
import { FileDiff, Undo2 } from 'lucide-react';
import type { WorkspaceFile } from '../types';
import { diffHunks, diffLines } from '../lib/diff';

const MAX_RENDERED_LINES = 3_000;

export default function CanvasDiff({ file, onRestore }: { file: WorkspaceFile; onRestore: () => void }) {
  const result = useMemo(() => file.previousContent === undefined ? null : diffLines(file.previousContent, file.content), [file.id, file.previousContent, file.content]);
  if (!result) {
    return <div className="canvas-empty canvas-diff-empty">
      <FileDiff size={27} />
      <strong>No saved diff yet.</strong>
      <p>Edit this file, or attach it with <b>Edit with AI</b>. The app keeps the previous version for comparison.</p>
    </div>;
  }

  const added = result.lines.filter(({ kind }) => kind === 'added').length;
  const removed = result.lines.filter(({ kind }) => kind === 'removed').length;
  if (!added && !removed) {
    return <div className="canvas-empty canvas-diff-empty">
      <FileDiff size={27} />
      <strong>No changes to compare.</strong>
      <p>This file matches its saved comparison version.</p>
    </div>;
  }

  const allHunks = diffHunks(result.lines, 3);
  const hunks: { start: number; end: number }[] = [];
  let rowsRemaining = MAX_RENDERED_LINES;
  for (const hunk of allHunks) {
    if (rowsRemaining <= 0) break;
    const end = Math.min(hunk.end, hunk.start + rowsRemaining);
    hunks.push({ start: hunk.start, end });
    rowsRemaining -= end - hunk.start;
    if (end < hunk.end) break;
  }
  const renderedRows = hunks.reduce((total, hunk) => total + hunk.end - hunk.start, 0);
  const totalHunkRows = allHunks.reduce((total, hunk) => total + hunk.end - hunk.start, 0);
  return <section className="canvas-diff" aria-label={`Changes in ${file.name}`}>
    <div className="canvas-diff-heading">
      <strong>{file.name}</strong>
      <span className="diff-added-count">+{added} added</span>
      <span className="diff-removed-count">−{removed} removed</span>
      <button type="button" className="canvas-diff-restore" onClick={onRestore} title="Restore the saved previous version"><Undo2 size={13} /> Restore</button>
    </div>
    {result.simplified && <div className="canvas-diff-notice">Large file: showing a simplified replacement diff to keep Canvas responsive.</div>}
    {renderedRows < totalHunkRows && <div className="canvas-diff-notice">Showing {renderedRows.toLocaleString()} lines around the changes to keep Canvas responsive.</div>}
    <div className="canvas-diff-scroll">
      {hunks.map((hunk, index) => {
        const previousEnd = index === 0 ? 0 : hunks[index - 1].end;
        return <div className="canvas-diff-hunk" key={`${hunk.start}-${hunk.end}`}>
          {hunk.start > previousEnd && <div className="canvas-diff-omitted">··· {hunk.start - previousEnd} unchanged lines ···</div>}
          {result.lines.slice(hunk.start, hunk.end).map((line, lineIndex) => <div
            className={`canvas-diff-line diff-${line.kind}`}
            key={`${line.kind}-${line.oldLine ?? 'x'}-${line.newLine ?? 'x'}-${lineIndex}`}
          >
            <span className="canvas-diff-number">{line.oldLine ?? ''}</span>
            <span className="canvas-diff-number">{line.newLine ?? ''}</span>
            <span className="canvas-diff-mark" aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
            <code>{line.text || ' '}</code>
          </div>)}
        </div>;
      })}
    </div>
    <div className="canvas-diff-legend"><span><i className="diff-legend-added" /> Green · new code</span><span><i className="diff-legend-removed" /> Red · deleted code</span></div>
  </section>;
}
