import type { AttachedFile, ChatMessage, Conversation, WorkspaceFile } from '../types';

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
    files: [file], folders: [], deletedFiles: [], deletedFolders: [], selectedFileId: file.id,
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

function parseWorkspaceOperationsJson(value: string): { operations: unknown[] } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('operations' in parsed) || !Array.isArray(parsed.operations)) return null;
    return parsed as { operations: unknown[] };
  } catch {
    return null;
  }
}

function locateWorkspaceOperationsPayload(markdown: string): { parsed: { operations: unknown[] }; block: string | null } | null {
  const blocks = [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
  for (const block of blocks) {
    const language = block[1].trim();
    if (language && !/^(?:aiflux-workspace|json)(?:\s|$)/i.test(language)) continue;
    const parsed = parseWorkspaceOperationsJson(block[2]);
    if (parsed) return { parsed, block: block[0] };
  }
  const trimmed = markdown.trim();
  const parsed = parseWorkspaceOperationsJson(trimmed);
  return parsed ? { parsed, block: null } : null;
}

export function extractCodeFiles(
  markdown: string,
  existing: WorkspaceFile[],
  editableTargets: Pick<WorkspaceFile, 'id' | 'name' | 'content'>[] = [],
  allowStarterReplacement = true,
): WorkspaceFile[] {
  const blocks = /```([^\n]*)\n([\s\S]*?)```/g;
  const found: WorkspaceFile[] = [];
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(markdown)) !== null) {
    const info = match[1].trim();
    let content = match[2].replace(/\n$/, '');
    if (!content.trim()) continue;
    const language = info.split(/\s+/)[0]?.replace(/^\./, '').toLowerCase() || 'text';
    if (language === 'aiflux-workspace' || parseWorkspaceOperationsJson(content)) continue;
    const filenameMatch = info.match(/(?:filename|file|title)\s*=\s*["']?([^\s"']+)/i);
    const colonMatch = info.match(/^\w+:([^\s]+)/);
    const commentMatch = content.match(/^(?:\/\/|#|<!--)\s*(?:file(?:name)?\s*:\s*)?([\w./-]+\.[a-z\d]+)(?:\s*-->)?\s*\n/i);
    let name = safeFilename(filenameMatch?.[1] || colonMatch?.[1] || commentMatch?.[1] || `snippet-${found.length + 1}.${extensionFor(language)}`);
    if (commentMatch && !filenameMatch && !colonMatch) content = content.slice(commentMatch[0].length);

    const collision = [...existing, ...found].find((file) => file.name === name);
    const editTarget = collision && editableTargets.find((target) =>
      target.id === collision.id && target.name === name && target.content === collision.content,
    );
    if (!collision && editableTargets.some((target) => target.name === name)) {
      // The user removed or renamed this snapshot target while the model was responding.
      // Do not resurrect it from a stale reply.
      continue;
    }
    if (collision && editTarget) {
      found.push({
        id: collision.id, name, content, origin: 'generated',
        previousContent: collision.content, lastChangedBy: 'ai',
      });
      continue;
    }

    let previousContent = '';
    if (collision && (collision.origin !== 'starter' || !allowStarterReplacement)) {
      // Existing Canvas files can only be edited when the current request authorizes
      // a complete replacement of that exact, unchanged file. Other collisions version.
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

export const MAX_CANVAS_CONTEXT_CHARS = 120_000;
export type CanvasEditableTarget = Pick<WorkspaceFile, 'id' | 'name' | 'content'>;
export type WorkspaceOperation =
  | { type: 'create-folder'; path: string }
  | { type: 'delete-folder'; path: string }
  | { type: 'rename-folder'; from: string; to: string }
  | { type: 'delete-file'; path: string }
  | { type: 'rename-file'; from: string; to: string };

export function inferFolderPaths(files: WorkspaceFile[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.name.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join('/'));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

export function expandFolderPaths(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

export function buildCanvasContext(
  files: WorkspaceFile[], folders: string[] = [], selectedFileId: string | null = null,
  maxChars = MAX_CANVAS_CONTEXT_CHARS,
): { text: string; editableFiles: CanvasEditableTarget[]; truncatedFiles: string[]; manifestTruncated: boolean } {
  const activeFolders = expandFolderPaths([...folders, ...inferFolderPaths(files)]);
  const selected = files.find((file) => file.id === selectedFileId);
  const orderedFiles = selected ? [selected, ...files.filter((file) => file.id !== selected.id)] : [...files];
  const fileManifest = files.map((file) => `- ${file.name}`).join('\n') || '- (no files)';
  const folderManifest = activeFolders.map((folder) => `- ${folder}/`).join('\n') || '- (no folders)';
  const manifestLimit = Math.min(8_000, Math.max(500, Math.floor(maxChars / 5)));
  const manifestTruncated = fileManifest.length > manifestLimit || folderManifest.length > manifestLimit;
  const manifest = fileManifest.length > manifestLimit ? `${fileManifest.slice(0, manifestLimit)}\n- [file list truncated]` : fileManifest;
  const folderList = folderManifest.length > manifestLimit ? `${folderManifest.slice(0, manifestLimit)}\n- [folder list truncated]` : folderManifest;
  const header = [
    `Canvas workspace context (automatic): current snapshot of ${files.length} files and ${activeFolders.length} folders.`,
    `Selected Canvas file: ${selected?.name || '(none)'}`,
    `Workspace folders:\n${folderList}`,
    `Workspace files:\n${manifest}`,
    'The following are current file contents. Only files shown in full may be replaced; folder and file paths are relative to this Canvas.',
  ].join('\n\n');
  const footerReserve = Math.min(2_000, Math.max(300, Math.floor(maxChars / 40)));
  let remaining = Math.max(0, maxChars - header.length - footerReserve);
  const sections: string[] = [];
  const editableFiles: CanvasEditableTarget[] = [];
  const truncatedFiles: string[] = [];
  for (const file of orderedFiles) {
    const opening = `\n\n--- BEGIN CANVAS FILE: ${file.name} ---\n`;
    const closing = `\n--- END CANVAS FILE: ${file.name} ---`;
    const fullLength = opening.length + file.content.length + closing.length;
    if (fullLength <= remaining) {
      sections.push(`${opening}${file.content}${closing}`);
      remaining -= fullLength;
      editableFiles.push({ id: file.id, name: file.name, content: file.content });
      continue;
    }
    const partialLength = Math.max(0, remaining - opening.length - closing.length - 80);
    if (partialLength > 0) {
      sections.push(`${opening}${file.content.slice(0, partialLength)}\n[TRUNCATED: ${file.content.length - partialLength} characters omitted]${closing}`);
      remaining -= opening.length + partialLength + closing.length + 80;
    }
    truncatedFiles.push(file.name);
    for (const omitted of orderedFiles.slice(orderedFiles.indexOf(file) + 1)) truncatedFiles.push(omitted.name);
    break;
  }
  const omittedNames = truncatedFiles.join(', ');
  const omittedLimit = Math.max(40, footerReserve - 180);
  const omittedSummary = omittedNames.length > omittedLimit ? `${omittedNames.slice(0, omittedLimit)}…` : omittedNames;
  const notice = truncatedFiles.length
    ? `\n\n[Canvas context limit: full contents were included for ${editableFiles.length} of ${files.length} files. Truncated or omitted: ${omittedSummary}]`
    : '';
  const fullText = `${header}${sections.join('')}${notice}`;
  return { text: fullText.length <= maxChars ? fullText : fullText.slice(0, maxChars), editableFiles, truncatedFiles, manifestTruncated };
}

function safeWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim().replaceAll('\\', '/');
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input) || input.split('/').some((part) => part === '.' || part === '..')) return null;
  const path = safeFilename(input);
  return path && path !== 'snippet.txt' ? path : null;
}

export function extractWorkspaceOperations(markdown: string): WorkspaceOperation[] {
  const payload = locateWorkspaceOperationsPayload(markdown);
  if (!payload) return [];
  return payload.parsed.operations.slice(0, 30).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const operation = candidate as Record<string, unknown>;
    const type = operation.type;
    if (type === 'create-folder' || type === 'delete-folder' || type === 'delete-file') {
      const path = safeWorkspacePath(operation.path);
      return path ? [{ type, path } as WorkspaceOperation] : [];
    }
    if (type === 'rename-file' || type === 'rename-folder') {
      const from = safeWorkspacePath(operation.from);
      const to = safeWorkspacePath(operation.to);
      return from && to && from !== to ? [{ type, from, to } as WorkspaceOperation] : [];
    }
    return [];
  });
}

export function normalizeWorkspaceOperationOutput(markdown: string, operations: WorkspaceOperation[]): string {
  if (!operations.length) return markdown;
  const payload = locateWorkspaceOperationsPayload(markdown);
  if (!payload) return markdown;
  const actionBlock = `\`\`\`aiflux-workspace\n${JSON.stringify({ operations }, null, 2)}\n\`\`\``;
  return payload.block ? markdown.replace(payload.block, actionBlock) : actionBlock;
}

function hasPositiveAction(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0;
    const clauseStart = Math.max(text.lastIndexOf('.', index), text.lastIndexOf('!', index), text.lastIndexOf('?', index), text.lastIndexOf(';', index), text.lastIndexOf('\n', index)) + 1;
    const preceding = text.slice(clauseStart, index).split(/[,;]|\b(?:but|however|instead|except|rather than)\b/i).at(-1) || '';
    if (/\b(?:don't|dont|do not|not|never|without|avoid|skip|no need to|no|nunca|jamás|jamas)\b(?:\s+\w+){0,3}\s*$/i.test(preceding)) continue;
    return true;
  }
  return false;
}

export function requestsCanvasMutation(text: string): boolean {
  const informationalQuestion = /^\s*(?:how\b|what\b|why\b|which\b|explain\b|tell me\b|do you think\b|can you explain\b|could you explain\b|can you tell me\b|could you tell me\b)/i.test(text);
  if (informationalQuestion && !/\b(?:please|also|then)\b/i.test(text)) return false;
  return hasPositiveAction(text, /\b(?:edit\w*|chang\w*|modif\w*|updat\w*|fix(?:es|ed|ing)?|refactor\w*|rewrit\w*|redesign\w*|implement\w*|creat\w*|build\w*|add\w*|delet\w*|remov\w*|renam\w*|mov\w*|replac\w*|writ\w*|mak(?:e|es|ing)|new|convert\w*|styl\w*|improv\w*|edita\w*|cambi\w*|modific\w*|actualiz\w*|arregl\w*|refactoriza\w*|reescrib\w*|rediseñ\w*|implementa\w*|crea\w*|construy\w*|agreg\w*|elimin\w*|borr\w*|renombr\w*|muev\w*|reemplaz\w*|haz\w*|hag\w*)\b/gi);
}

export function filterWorkspaceOperationsForRequest(operations: WorkspaceOperation[], request: string): WorkspaceOperation[] {
  if (!requestsCanvasMutation(request)) return [];
  const asksDeletion = hasPositiveAction(request, /\b(?:delet\w*|remov\w*|eras\w*|discard\w*|clear\w*|elimin\w*|borr\w*|suprim\w*)\b/gi);
  const asksRename = hasPositiveAction(request, /\b(?:renam\w*|mov\w*|relocat\w*|renombr\w*|muev\w*|traslad\w*|change the name)\b/gi);
  const asksCreateFolder = hasPositiveAction(request, /\b(?:creat\w*|mak(?:e|es|ing)|add\w*|new|crear|crea|agrega|nuevo|nueva)\b/gi) && /\b(folder|directory|carpeta|directorio)\b/i.test(request);
  return operations.filter((operation) => {
    if (operation.type === 'delete-file' || operation.type === 'delete-folder') return asksDeletion;
    if (operation.type === 'rename-file' || operation.type === 'rename-folder') return asksRename;
    return asksCreateFolder;
  });
}

export function applyWorkspaceOperations(
  files: WorkspaceFile[], folders: string[] = [], deletedFiles: WorkspaceFile[] = [], deletedFolders: string[] = [], operations: WorkspaceOperation[] = [],
): { files: WorkspaceFile[]; folders: string[]; deletedFiles: WorkspaceFile[]; deletedFolders: string[]; applied: string[]; skipped: string[] } {
  let activeFiles = [...files];
  let activeFolders = expandFolderPaths([...folders, ...inferFolderPaths(files)]);
  let archivedFiles = [...deletedFiles];
  let archivedFolders = [...deletedFolders];
  const applied: string[] = [];
  const skipped: string[] = [];
  const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
  const fileBlocksPath = (path: string) => activeFiles.some((file) => file.name === path || path.startsWith(`${file.name}/`));

  for (const operation of operations) {
    if (operation.type === 'create-folder') {
      if (activeFolders.includes(operation.path) || fileBlocksPath(operation.path)) { skipped.push(`Folder already exists or conflicts with a file: ${operation.path}`); continue; }
      activeFolders.push(operation.path);
      applied.push(`Created folder ${operation.path}/`);
      continue;
    }
    if (operation.type === 'delete-file') {
      const target = activeFiles.find((file) => file.name === operation.path);
      if (!target) { skipped.push(`File not found: ${operation.path}`); continue; }
      activeFiles = activeFiles.filter((file) => file.id !== target.id);
      archivedFiles = [...archivedFiles.filter((file) => file.id !== target.id), target];
      applied.push(`Moved ${operation.path} to Recently deleted`);
      continue;
    }
    if (operation.type === 'rename-file') {
      const target = activeFiles.find((file) => file.name === operation.from);
      if (!target) { skipped.push(`File not found: ${operation.from}`); continue; }
      if (fileBlocksPath(operation.to) || activeFiles.some((file) => within(file.name, operation.to)) || activeFolders.includes(operation.to)) { skipped.push(`Destination already exists or conflicts with another path: ${operation.to}`); continue; }
      activeFiles = activeFiles.map((file) => file.id === target.id ? { ...file, name: operation.to } : file);
      activeFolders = [...new Set([...activeFolders, ...inferFolderPaths(activeFiles)])];
      applied.push(`Renamed ${operation.from} to ${operation.to}`);
      continue;
    }
    if (operation.type === 'delete-folder') {
      const matchingFiles = activeFiles.filter((file) => within(file.name, operation.path));
      const matchingFolders = activeFolders.filter((folder) => within(folder, operation.path));
      if (!matchingFolders.length && !matchingFiles.length) { skipped.push(`Folder not found: ${operation.path}`); continue; }
      activeFiles = activeFiles.filter((file) => !within(file.name, operation.path));
      archivedFiles = [...archivedFiles.filter((file) => !matchingFiles.some((deleted) => deleted.id === file.id)), ...matchingFiles];
      activeFolders = activeFolders.filter((folder) => !within(folder, operation.path));
      archivedFolders = [...new Set([...archivedFolders, operation.path, ...matchingFolders])];
      applied.push(`Moved ${operation.path}/, ${matchingFiles.length} file(s), and ${matchingFolders.length} folder(s) to Recently deleted`);
      continue;
    }
    if (operation.type === 'rename-folder') {
      const exists = activeFolders.some((folder) => within(folder, operation.from)) || activeFiles.some((file) => within(file.name, operation.from));
      if (!exists) { skipped.push(`Folder not found: ${operation.from}`); continue; }
      if (within(operation.to, operation.from) || fileBlocksPath(operation.to) || activeFiles.some((file) => within(file.name, operation.to)) || activeFolders.some((folder) => within(folder, operation.to))) {
        skipped.push(`Destination conflicts with an existing path: ${operation.to}`); continue;
      }
      const movePath = (path: string) => within(path, operation.from) ? `${operation.to}${path.slice(operation.from.length)}` : path;
      activeFiles = activeFiles.map((file) => ({ ...file, name: movePath(file.name) }));
      activeFolders = [...new Set(activeFolders.map(movePath).concat(inferFolderPaths(activeFiles)))];
      applied.push(`Renamed folder ${operation.from}/ to ${operation.to}/`);
    }
  }
  activeFolders = expandFolderPaths([...activeFolders, ...inferFolderPaths(activeFiles)]);
  return { files: activeFiles, folders: activeFolders, deletedFiles: archivedFiles, deletedFolders: [...new Set(archivedFolders)], applied, skipped };
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

export async function downloadProject(files: WorkspaceFile[], folders: string[] = []) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const folder of folders) zip.folder(safeFilename(folder));
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

function formatAttachmentForPrompt(file: AttachedFile): string {
  if (file.canvasFileId) {
    return `Canvas file attached for editing: ${file.name}\nThis is the user's selected Canvas file. Its complete current contents are included below. Read this file; if asked to edit it, return a complete replacement using this exact path.\n\`\`\`text filename="${file.name}"\n${file.content}\n\`\`\``;
  }
  if (file.canvasPartial) {
    return `Canvas file attached for context only (partial): ${file.name}\nOnly the first 30 KB is included; this is not the complete file and cannot be safely applied as a full-file edit.\n\`\`\`text filename="${file.name}"\n${file.content}\n\`\`\``;
  }
  return `Attached file: ${file.name}\n\`\`\`\n${file.content}\n\`\`\``;
}

export function toProviderMessages(messages: ChatMessage[], canvasContext = ''): { role: 'user' | 'assistant'; content: string }[] {
  const usable = messages.filter((message) => message.role === 'user' || (message.content.trim() && message.status !== 'error'));
  const recent = usable.slice(-30);
  const latestCanvasAttachment = new Map<string, number>();
  recent.forEach((message, index) => message.attachments?.forEach((file) => {
    if (file.canvasFileId) latestCanvasAttachment.set(file.canvasFileId, index);
  }));
  const results = recent.map((message, index) => {
    const attachments = message.attachments?.filter((file) =>
      !file.canvasFileId || latestCanvasAttachment.get(file.canvasFileId) === index,
    ) || [];
    return {
      role: message.role,
      content: message.content + (attachments.length
        ? '\n\n' + attachments.map(formatAttachmentForPrompt).join('\n\n')
        : ''),
    };
  });
  if (canvasContext) {
    let latestUserIndex = -1;
    for (let index = results.length - 1; index >= 0; index--) {
      if (results[index].role === 'user') { latestUserIndex = index; break; }
    }
    if (latestUserIndex >= 0) results[latestUserIndex].content += `\n\n${canvasContext}`;
  }
  while (results.length > 1 && results.reduce((sum, message) => sum + message.content.length, 0) > 160_000) results.shift();
  while (results.length > 1 && results[0].role === 'assistant') results.shift();
  return results;
}
