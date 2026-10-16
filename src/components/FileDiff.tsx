import type { DiffLine } from '../lib/diff';

const MARKER = { add: '+', remove: '−', context: ' ', skip: '⋯' } as const;

export default function FileDiff({ lines }: { lines: DiffLine[] }) {
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'remove').length;
  if (!added && !removed) return <div className="file-diff-empty">No changes — the file is identical.</div>;
  return <div className="file-diff" aria-label="Changes to this file">
    <div className="file-diff-summary"><span className="diff-added">+{added}</span><span className="diff-removed">−{removed}</span><span>{added + removed} changed {added + removed === 1 ? 'line' : 'lines'}</span></div>
    <div className="file-diff-body">{lines.map((line, index) => <div className={`diff-line diff-${line.kind}`} key={index}>
      <span className="diff-no">{line.before ?? ''}</span>
      <span className="diff-no">{line.after ?? ''}</span>
      <span className="diff-marker" aria-hidden="true">{MARKER[line.kind]}</span>
      <code className="diff-text">{line.text || ' '}</code>
    </div>)}</div>
  </div>;
}
