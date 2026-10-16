import type { ChatMessage, Conversation, WorkspaceFile } from '../types';

export const STARTER_CODE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your next idea starts here</title>
  <style>
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: #09090b;
      color: #f2eff7;
      font-family: system-ui, sans-serif;
    }
    .card { text-align: center; padding: 2rem; }
    .spark { color: #6d35f4; font-size: 2.5rem; }
    h1 { font-size: clamp(2rem, 6vw, 4rem); margin: .7rem 0; }
    p { color: #a69eae; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spark">✳</div>
    <h1>Make something great.</h1>
    <p>Your canvas is ready. Make it yours.</p>
  </div>
</body>
</html>`;

export function createDraft(): Conversation {
  const file: WorkspaceFile = { id: crypto.randomUUID(), name: 'index.html', content: STARTER_CODE, origin: 'starter', previousContent: STARTER_CODE };
  return {
    id: crypto.randomUUID(), title: 'New conversation',
    createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    files: [file], selectedFileId: file.id,
  };
}

export function safeFilename(input: string): string {
  const cleaned = input.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\.\./g, '').replace(/[^a-zA-Z0-9_./-]/g, '-');
  return cleaned.split('/').filter(Boolean).join('/').slice(0, 100) || 'snippet.txt';
}

export function extensionFor(language: string): string {
  const extensions: Record<string, string> = {
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx',
    html: 'html', css: 'css', scss: 'scss', python: 'py', py: 'py', json: 'json',
    markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', svg: 'svg',
    sql: 'sql', rust: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    yaml: 'yaml', yml: 'yml', xml: 'xml', text: 'txt', txt: 'txt',
  };
  return extensions[language.toLowerCase()] || 'txt';
}

export function fileLanguage(name: string): string {
  const ext = name.split('.').at(-1)?.toLowerCase() || 'txt';
  return ({ js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', html: 'HTML', css: 'CSS',
    json: 'JSON', py: 'Python', md: 'Markdown', svg: 'SVG', sh: 'Shell', rs: 'Rust',
    go: 'Go', java: 'Java', txt: 'Text' } as Record<string, string>)[ext] || ext.toUpperCase();
}

export function fileColor(name: string): string {
  const ext = name.split('.').at(-1)?.toLowerCase();
  if (ext === 'html') return 'coral';
  if (ext === 'css' || ext === 'scss') return 'blue';
  if (['js', 'jsx', 'ts', 'tsx'].includes(ext || '')) return 'yellow';
  if (ext === 'json') return 'violet';
  if (ext === 'py') return 'green';
  return 'muted';
}

export function extractCodeFiles(
  markdown: string,
  existing: WorkspaceFile[],
  editableTargets: Pick<WorkspaceFile, 'id' | 'name' | 'content'>[] = [],
): WorkspaceFile[] {
  const blocks = /```([^\n]*)\n([\s\S]*?)```/g;
  const found: WorkspaceFile[] = [];
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(markdown)) !== null) {
    const info = match[1].trim();
    let content = match[2].replace(/\n$/, '');
    if (!content.trim()) continue;
    const language = info.split(/\s+/)[0]?.replace(/^\./, '').toLowerCase() || 'text';
    const filenameMatch = info.match(/(?:filename|file|title)\s*=\s*["']?([^\s"']+)/i);
    const colonMatch = info.match(/^\w+:([^\s]+)/);
    const commentMatch = content.match(/^(?:\/\/|#|<!--)\s*(?:file(?:name)?\s*:\s*)?([\w./-]+\.[a-z\d]+)(?:\s*-->)?\s*\n/i);
    let name = safeFilename(filenameMatch?.[1] || colonMatch?.[1] || commentMatch?.[1] || `snippet-${found.length + 1}.${extensionFor(language)}`);
    if (commentMatch && !filenameMatch && !colonMatch) content = content.slice(commentMatch[0].length);

    const collision = [...existing, ...found].find((file) => file.name === name);
    const editTarget = collision && editableTargets.find((target) =>
      target.id === collision.id && target.name === name && target.content === collision.content,
    );
    if (collision && editTarget) {
      found.push({
        id: collision.id, name, content, origin: 'generated',
        previousContent: collision.content, lastChangedBy: 'ai',
      });
      continue;
    }

    let previousContent = '';
    if (collision && collision.origin !== 'starter') {
      // Existing Canvas files can only be edited when the user attached that exact,
      // unchanged file. Every other name collision gets a separate version.
      const dot = name.lastIndexOf('.');
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const extension = dot >= 0 ? name.slice(dot) : '';
      let version = 2;
      while ([...existing, ...found].some((file) => file.name === `${base}-${version}${extension}`)) version++;
      name = `${base}-${version}${extension}`;
    } else if (collision) {
      previousContent = collision.content;
    }
    found.push({ id: crypto.randomUUID(), name, content, origin: 'generated', previousContent, lastChangedBy: 'ai' });
  }
  return found;
}

export function mergeGeneratedFiles(existing: WorkspaceFile[], generated: WorkspaceFile[]): WorkspaceFile[] {
  const files = [...existing];
  for (const file of generated) {
    const existingIndex = files.findIndex((item) => item.id === file.id);
    if (existingIndex >= 0) {
      files.splice(existingIndex, 1, { ...file, previousContent: file.previousContent ?? files[existingIndex].content });
      continue;
    }
    const starterIndex = files.findIndex((item) => item.name === file.name && item.origin === 'starter');
    if (starterIndex >= 0) files.splice(starterIndex, 1, { ...file, previousContent: file.previousContent ?? files[starterIndex].content });
    else files.push({ ...file, previousContent: file.previousContent ?? '' });
  }
  return files;
}

function previewCsp(allowRemoteImages: boolean): string {
  const imageSources = allowRemoteImages ? 'data: blob: https:' : 'data: blob:';
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
}

export function buildPreview(files: WorkspaceFile[], { allowRemoteImages = false }: { allowRemoteImages?: boolean } = {}): string | null {
  const html = files.find((file) => file.name.toLowerCase().endsWith('.html'));
  const svg = html ? undefined : files.find((file) => file.name.toLowerCase().endsWith('.svg'));
  if (!html && !svg) return null;
  let document = html?.content || svg?.content || '';
  // Wrap HTML fragments as a real document so the restrictive CSP is always applied.
  if (!/<html\b/i.test(document)) document = `<!doctype html><html><head></head><body>${document}</body></html>`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${previewCsp(allowRemoteImages)}">`;
  if (/<head\b[^>]*>/i.test(document)) document = document.replace(/<head\b[^>]*>/i, (opening) => `${opening}${meta}`);
  else document = document.replace(/<html\b[^>]*>/i, (opening) => `${opening}<head>${meta}</head>`);
  const css = files.filter((file) => /\.css$/i.test(file.name)).map((file) => file.content.replace(/<\/style/gi, '<\\/style')).join('\n');
  const js = files.filter((file) => /\.js$/i.test(file.name)).map((file) => file.content.replace(/<\/script/gi, '<\\/script')).join('\n');
  if (css) document = document.replace(/<\/head>/i, `<style>${css}</style></head>`);
  if (js) document = document.replace(/<\/body>/i, `<script>${js}</script></body>`);
  return document;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadFile(file: WorkspaceFile) {
  downloadBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), safeFilename(file.name).split('/').at(-1) || 'file.txt');
}

export async function downloadProject(files: WorkspaceFile[]) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of files) zip.file(safeFilename(file.name), file.content);
  downloadBlob(await zip.generateAsync({ type: 'blob' }), 'aiflux-project.zip');
}

export function downloadConversation(conversation: Conversation) {
  const text = [
    `# ${conversation.title}`, '', 'Exported from AIFLUX', '',
    ...conversation.messages.flatMap((message: ChatMessage) => [
      `## ${message.role === 'user' ? 'You' : 'AIFLUX'}`,
      message.attachments?.length ? `Attachments: ${message.attachments.map((file) => file.name).join(', ')}` : '',
      message.searchSkipped ? 'No live web search was used.' : '',
      message.search ? `Web search: ${message.search.query}\n${message.search.sources.map((source, index) => `- [${index + 1}] ${source.title} — ${source.url}`).join('\n') || 'No sources found.'}` : '',
      '', message.content, '',
    ]),
  ].join('\n');
  downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${safeFilename(conversation.title.toLowerCase().replace(/\s+/g, '-'))}.md`);
}

export function toProviderMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  const usable = messages.filter((message) => message.role === 'user' || (message.content.trim() && message.status !== 'error'));
  const results = usable.slice(-30).map((message) => ({
    role: message.role,
    content: message.content + (message.attachments?.length
      ? '\n\n' + message.attachments.map((file) => `Attached file: ${file.name}\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')
      : ''),
  }));
  while (results.length > 1 && results.reduce((sum, message) => sum + message.content.length, 0) > 160_000) results.shift();
  while (results.length > 1 && results[0].role === 'assistant') results.shift();
  return results;
}
