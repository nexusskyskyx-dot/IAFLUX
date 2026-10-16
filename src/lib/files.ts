import type { ChatMessage, Conversation, WorkspaceFile } from '../types';
import { newId } from './id.ts';

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
      background: #0d0a0e;
      color: #eae4f0;
      font-family: system-ui, sans-serif;
    }
    .card { text-align: center; padding: 2rem; }
    .spark { color: #945df9; font-size: 2.5rem; }
    h1 { font-size: clamp(2rem, 6vw, 4rem); margin: .7rem 0; }
    p { color: #978f9d; line-height: 1.6; }
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
  const file: WorkspaceFile = { id: newId(), name: 'index.html', content: STARTER_CODE, origin: 'starter' };
  return {
    id: newId(), title: 'New conversation',
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

/** Wrapper tags models fall back on when they ignore the write protocol. */
const WRAPPER = /<(document|file|artifact)\b[^>]*>\n?([\s\S]*?)<\/\1\s*>/gi;

/** Best-effort language for content that arrived without one. */
function guessLanguage(content: string): string {
  if (/^\s*(<!doctype html|<html[\s>])/i.test(content)) return 'html';
  if (/^\s*<svg[\s>]/i.test(content)) return 'svg';
  if (/^\s*[.#@][\w-]+[^{;]*\{/m.test(content) && /[};]\s*$/.test(content)) return 'css';
  if (/^\s*[{[]/.test(content) && /[}\]]\s*$/.test(content)) return 'json';
  if (/^\s*(from |import |def |class )\w/m.test(content)) return 'py';
  if (/^\s*(import |export |function |const |let |var |=>)/m.test(content)) return 'js';
  return 'txt';
}

/**
 * Turns wrapper blocks into fenced ones so a model that emits `<document>`
 * instead of a tagged write still gets its code onto the canvas.
 */
function unwrapBlocks(markdown: string): string {
  return markdown.replace(WRAPPER, (_match, _tag: string, body: string) => {
    const content = body.replace(/^\n/, '').replace(/\n$/, '');
    if (!content.trim()) return '';
    return `\n\`\`\`${guessLanguage(content)}\n${content}\n\`\`\`\n`;
  });
}

export function extractCodeFiles(markdown: string, existing: WorkspaceFile[]): WorkspaceFile[] {
  const blocks = /```([^\n]*)\n([\s\S]*?)```/g;
  const found: WorkspaceFile[] = [];
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(unwrapBlocks(markdown))) !== null) {
    const info = match[1].trim();
    let content = match[2].replace(/\n$/, '');
    if (!content.trim()) continue;
    const language = info.split(/\s+/)[0]?.replace(/^\./, '').toLowerCase() || 'text';
    const filenameMatch = info.match(/(?:filename|file|title)\s*=\s*["']?([^\s"']+)/i);
    const colonMatch = info.match(/^\w+:([^\s]+)/);
    const commentMatch = content.match(/^(?:\/\/|#|<!--)\s*(?:file(?:name)?\s*:\s*)?([\w./-]+\.[a-z\d]+)(?:\s*-->)?\s*\n/i);
    let name = safeFilename(filenameMatch?.[1] || colonMatch?.[1] || commentMatch?.[1] || `snippet-${found.length + 1}.${extensionFor(language)}`);
    if (commentMatch && !filenameMatch && !colonMatch) content = content.slice(commentMatch[0].length);
    // Never silently overwrite a file edited by the user or generated in a previous answer.
    const collision = [...existing, ...found].find((file) => file.name === name);
    if (collision && collision.origin !== 'starter') {
      const dot = name.lastIndexOf('.');
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const extension = dot >= 0 ? name.slice(dot) : '';
      let version = 2;
      while ([...existing, ...found].some((file) => file.name === `${base}-${version}${extension}`)) version++;
      name = `${base}-${version}${extension}`;
    }
    found.push({ id: newId(), name, content, origin: 'generated' });
  }
  return found;
}

/**
 * Removes fenced blocks that carry an explicit filename. Those are the blocks
 * `extractCodeFiles` turns into canvas files, so keeping them in the
 * transcript would put the code back into the chat. Blocks without a name are
 * illustrative snippets and are left alone.
 */
const NAMED_FENCE = /\n?```[^\n]*(?:filename|file|title)\s*=\s*["']?([^\s"']+)[^\n]*\n[\s\S]*?```\n?/gi;

export function stripNamedCodeBlocks(markdown: string): string {
  return markdown.replace(NAMED_FENCE, '\n');
}

/**
 * Chars of canvas file contents sent to the model as context. Bounded on
 * purpose: every message would otherwise carry the whole workspace.
 */
export const CANVAS_CONTEXT_BUDGET = 40_000;

export type CanvasEntry = { name: string; lines: number; content?: string; omitted?: boolean };

/**
 * What the model is told about the canvas. Small files arrive with their
 * contents so the model can patch them accurately and has no reason to invent
 * a way of reading them; anything that would blow the budget is listed by name
 * only. Files are considered in order, so one huge file cannot crowd out the
 * small ones behind it.
 */
export function canvasContext(files: WorkspaceFile[], budget = CANVAS_CONTEXT_BUDGET): CanvasEntry[] {
  let used = 0;
  return files.map((file) => {
    const lines = file.content.split('\n').length;
    if (file.content.length <= budget - used) {
      used += file.content.length;
      return { name: file.name, lines, content: file.content };
    }
    return { name: file.name, lines, omitted: true };
  });
}

export function mergeGeneratedFiles(existing: WorkspaceFile[], generated: WorkspaceFile[]): WorkspaceFile[] {
  const files = [...existing];
  for (const file of generated) {
    const starterIndex = files.findIndex((item) => item.name === file.name && item.origin === 'starter');
    if (starterIndex >= 0) files.splice(starterIndex, 1, file);
    else files.push(file);
  }
  return files;
}

/**
 * What a previewed page may reach.
 *
 * Remote scripts, remote images and every JavaScript network call stay
 * blocked, so a generated page cannot phone home, run someone else's code, or
 * leak that the preview was opened. Web fonts are the deliberate exception: a
 * display face is most of what separates a designed page from a default one,
 * and forbidding it condemned every result to the system font stack, which
 * reads as generic no matter how good the layout is.
 */
/**
 * Reports what the sandbox refused, in the page itself.
 *
 * The CSP is right to refuse a CDN stylesheet, but the refusal used to be
 * silent: the tag simply does not load and the page renders with no styles at
 * all — which is indistinguishable from a model that wrote no CSS. Worse, the
 * most common way to write a landing page is a Tailwind CDN script tag, so the
 * failure was both near-certain and invisible. Saying so in the page turns
 * "why does my output look like plain HTML" into something with a cause and a
 * fix, and it is the one thing the model cannot do for itself: it cannot see
 * the preview.
 */
const BLOCKED_REPORTER = `<script>
(function () {
  var verbs = { 'script-src': 'scripts', 'style-src': 'stylesheets', 'img-src': 'images', 'font-src': 'fonts', 'connect-src': 'network requests', 'default-src': 'resources' };
  var blocked = [];
  document.addEventListener('securitypolicyviolation', function (event) {
    var uri = event.blockedURI || '';
    var host = uri.replace(/^[a-z]+:\/\//i, '').split('/')[0] || uri || 'the page';
    var key = event.directive + '|' + host;
    for (var i = 0; i < blocked.length; i += 1) if (blocked[i].key === key) return;
    blocked.push({ key: key, what: verbs[event.directive] || event.directive, host: host });
    draw();
  }, true);
  function draw() {
    var box = document.getElementById('aiflux-blocked-notice');
    if (!box) {
      box = document.createElement('div');
      box.id = 'aiflux-blocked-notice';
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;margin:0;padding:10px 14px;background:#7f1d1d;color:#fff;font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4)';
      (document.body || document.documentElement).appendChild(box);
    }
    var list = blocked.map(function (entry) { return entry.what + ' from ' + entry.host; }).join('; ');
    box.textContent = 'Preview sandbox blocked ' + list + '. The page is rendering WITHOUT them, so a page built on a CDN stylesheet shows up as unstyled HTML. Put styles in a <style> block or a local .css file, and build images from inline SVG or a data: URL.';
  }
})();
<\/script>`;

const CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; form-action 'none'; base-uri 'none'`;

export function buildPreview(files: WorkspaceFile[]): string | null {
  const html = files.find((file) => file.name.toLowerCase().endsWith('.html'));
  const svg = html ? undefined : files.find((file) => file.name.toLowerCase().endsWith('.svg'));
  if (!html && !svg) return null;
  let document = html?.content || svg?.content || '';
  // Wrap HTML fragments as a real document so the restrictive CSP is always applied.
  if (!/<html\b/i.test(document)) document = `<!doctype html><html><head></head><body>${document}</body></html>`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  // The reporter goes in before anything else in the head so its listener is
  // registered before the first blocked request is made.
  if (/<head\b[^>]*>/i.test(document)) document = document.replace(/<head\b[^>]*>/i, (opening) => `${opening}${meta}${BLOCKED_REPORTER}`);
  else document = document.replace(/<html\b[^>]*>/i, (opening) => `${opening}<head>${meta}${BLOCKED_REPORTER}</head>`);
  const css = files.filter((file) => /\.css$/i.test(file.name)).map((file) => file.content.replace(/<\/style/gi, '<\\/style')).join('\n');
  const js = files.filter((file) => /\.js$/i.test(file.name)).map((file) => file.content.replace(/<\/script/gi, '<\\/script')).join('\n');
  // Pass a replacer function: CSS/JS containing `$&` or `$1` would otherwise be
  // treated as replacement patterns and corrupted.
  if (css) document = document.replace(/<\/head>/i, () => `<style>${css}</style></head>`);
  if (js) document = document.replace(/<\/body>/i, () => `<script>${js}</script></body>`);
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
