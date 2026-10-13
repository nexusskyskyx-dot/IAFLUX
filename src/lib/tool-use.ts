import type { ChatMessage, WorkspaceFile } from '../types.ts';
import { buildPreview, safeFilename, toProviderMessages } from './files.ts';

// Client-side tool execution for Canvas manipulation. Tools are invoked by the
// AI through <af-tool>...</af-tool> XML blocks in its streamed response. Each
// call produces a tool_result user/system-style message that is sent back so
// the model can inspect the outcome and chain further edits.

export type ToolName =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'create_file'
  | 'edit_file'
  | 'delete_file'
  | 'view_preview';

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, string>;
}

export interface ToolResult {
  id: string;
  name: ToolName;
  ok: boolean;
  output: string;
  // When the tool mutates files, the updated file list is returned so the UI
  // and conversation state stay in sync with what the model sees.
  files?: WorkspaceFile[];
  selectedFileId?: string | null;
}

export interface ToolResultMessage {
  role: 'user';
  content: string;
  toolResult: true;
}

export const MAX_TOOL_ROUNDS = 8;
const MAX_FILE_READ = 40_000;
const MAX_PREVIEW_CHARS = 12_000;
const TOTAL_FILES_LIMIT = 40;

const ALLOWED_EDIT_EXT = /\.(html|css|js|jsx|ts|tsx|json|md|txt|py|svg|xml|sh|yaml|yml|sql|rs|go|java)$/i;

// ---------------------------------------------------------------------------
// Tool call parsing
// ---------------------------------------------------------------------------

// Some providers (especially Groq/GPT-OSS) occasionally:
//   (a) HTML-escape the angle brackets as &lt; / &gt; before streaming them,
//   (b) emit the bare tool tag (<read_file>...</read_file>) instead of the
//       documented <af-tool name="read_file"> wrapper.
// We normalise both forms before parsing so tools still execute and don't
// leak as literal XML to the user.
const KNOWN_TOOL_TAGS = ['list_files', 'read_file', 'write_file', 'create_file', 'edit_file', 'delete_file', 'view_preview'];

function decodeToolEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normaliseToolBlocks(text: string): string {
  // Wrap any bare <list_files …>…</list_files>, <read_file …/>, etc. into
  // <af-tool name="…">…</af-tool> blocks so the main parser handles them.
  let out = text;
  for (const tag of KNOWN_TOOL_TAGS) {
    // Self-closing shorthand: <read_file filename="x"/>
    out = out.replace(
      new RegExp(`<${tag}\\b([^>]*?)/>`, 'g'),
      (_m, attrs) => `<af-tool name="${tag}"${attrs && attrs.trim() ? ` ${attrs.trim()}` : ''}></af-tool>`,
    );
    // Paired/attribute-only form: <read_file filename="x"></read_file>
    out = out.replace(
      new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g'),
      (_m, attrs, body) => `<af-tool name="${tag}"${attrs && attrs.trim() ? ` ${attrs.trim()}` : ''}>${body}</af-tool>`,
    );
  }
  return out;
}

// Strip fenced code blocks before scanning for tool invocations so the
// client doesn't execute sample/documentation blocks the model quotes inline.
function withoutFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => '`'.repeat(block.length));
}

export function extractToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const decoded = decodeToolEntities(text);
  const normalised = normaliseToolBlocks(decoded);
  const scanTarget = withoutFencedCode(normalised);
  const pattern = /<af-tool\b([^>]*)>([\s\S]*?)<\/af-tool>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scanTarget)) !== null) {
    const attrs = match[1] || '';
    const body = (match[2] || '').trim();
    const name = (attrs.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1] || '').trim();
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || `call_${calls.length + 1}`;
    const args: Record<string, string> = {};
    // Named <arg name="...">...</arg> children
    const argPattern = /<arg\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/arg>/g;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argPattern.exec(body)) !== null) {
      args[argMatch[1].trim()] = argMatch[2];
    }
    // Attribute arguments as fallback (for short args like filename="…")
    for (const attrMatch of attrs.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
      const key = attrMatch[1];
      if (key === 'name' || key === 'id') continue;
      if (!(key in args)) args[key] = attrMatch[2];
    }
    if (isToolName(name)) calls.push({ id, name, args });
  }
  return calls;
}

export function stripToolCalls(text: string): string {
  // Decode entities and wrap bare tags BEFORE stripping so escaped/bare tool
  // calls don't leak as literal XML in the rendered message.
  const decoded = decodeToolEntities(text);
  const normalised = normaliseToolBlocks(decoded);
  // Split on fenced code blocks; we only strip tool calls from OUTSIDE fences
  // so example/quoted <af-tool> snippets inside ``` are preserved verbatim.
  const segments = normalised.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const stripped = segments.map((segment) => {
    if (segment.startsWith('```') || segment.startsWith('~~~')) return segment;
    let s = segment;
    s = s.replace(/<af-tool\b[^>]*>[\s\S]*?<\/af-tool>/g, '');
    s = s.replace(/<af-tool\b[^>]*>[\s\S]*$/g, '');
    return s;
  });
  return stripped.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function isToolName(name: string): name is ToolName {
  return ['list_files', 'read_file', 'write_file', 'create_file', 'edit_file', 'delete_file', 'view_preview'].includes(name);
}

// ---------------------------------------------------------------------------
// Workspace snapshot injected into every user turn so the AI always knows
// which files exist (without needing an explicit list call first).
// ---------------------------------------------------------------------------

export function workspaceContext(files: WorkspaceFile[]): string {
  if (!files.length) {
    return [
      '<canvas-workspace>',
      'The Canvas is currently empty. Create an index.html file to start.',
      '</canvas-workspace>',
    ].join('\n');
  }
  const lines: string[] = ['<canvas-workspace>', 'Current Canvas files:'];
  for (const file of files) {
    lines.push(`- ${file.name} (${file.content.length} chars, origin: ${file.origin})`);
  }
  lines.push('');
  lines.push('Use the <af-tool> tags documented in the system prompt to read, create, edit, or delete files, or to inspect the rendered preview HTML.');
  lines.push('</canvas-workspace>');
  return lines.join('\n');
}

// Builds the message list actually sent to the provider: injects the workspace
// snapshot into the latest user message (or the final tool-result message) so
// the model always sees up-to-date file state without re-reading the whole
// conversation history.
export function buildProviderMessages(messages: ChatMessage[], files: WorkspaceFile[]): { role: 'user' | 'assistant'; content: string }[] {
  const base = toProviderMessages(messages);
  return injectWorkspaceSnapshot(base, files);
}

// Same as buildProviderMessages but accepts an already-built provider-formatted
// message list (used during the tool loop after appending tool-result messages).
// Strips any stale <canvas-workspace> blocks from prior user messages so the
// model only ever sees the most recent snapshot at the very end, and trims
// older messages to stay under the server's per-request size budget.
export function injectWorkspaceSnapshot(messages: { role: 'user' | 'assistant'; content: string }[], files: WorkspaceFile[]): { role: 'user' | 'assistant'; content: string }[] {
  const snapshot = workspaceContext(files);
  const cleaned = messages.map((message) => ({
    ...message,
    content: message.content.replace(/\n?\n?<canvas-workspace>[\s\S]*?<\/canvas-workspace>/g, ''),
  }));
  // Keep the tail of the conversation under a budget so long tool loops don't
  // blow past the server's 180k-char message cap. Always preserve the last
  // assistant+user pair.
  const BUDGET = 150_000;
  let trimmed = cleaned;
  while (trimmed.length > 2 && trimmed.reduce((sum, m) => sum + m.content.length, 0) > BUDGET) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.length > 1 && trimmed[0].role === 'assistant') trimmed = trimmed.slice(1);
  if (!trimmed.length) return cleaned;
  const last = trimmed[trimmed.length - 1];
  if (last.role !== 'user') {
    return [...trimmed, { role: 'user', content: `${snapshot}\n\nContinue.` }];
  }
  return trimmed.map((message, index) => index === trimmed.length - 1
    ? { ...message, content: `${message.content}\n\n${snapshot}` }
    : message);
}

export function formatToolResultMessage(result: ToolResult): ToolResultMessage {
  const head = result.ok ? `<tool-result id="${result.id}" name="${result.name}" status="ok">`
                          : `<tool-result id="${result.id}" name="${result.name}" status="error">`;
  return {
    role: 'user',
    content: `${head}\n${result.output.trim()}\n</tool-result>\nContinue. If you need another tool call, emit the next <af-tool> block. Otherwise answer the user in Markdown as usual. You do NOT need to summarise tool calls — just proceed.`,
    toolResult: true,
  };
}

// ---------------------------------------------------------------------------
// Tool executors — pure functions over the file list that return a ToolResult.
// ---------------------------------------------------------------------------

interface ExecContext {
  files: WorkspaceFile[];
  selectedFileId: string | null;
}

function safeName(input: string): string | null {
  const cleaned = safeFilename(input);
  if (!cleaned || cleaned === 'snippet.txt') return null;
  if (!ALLOWED_EDIT_EXT.test(cleaned)) return null;
  return cleaned;
}

function executeListFiles(ctx: ExecContext): ToolResult {
  if (!ctx.files.length) return { id: '', name: 'list_files', ok: true, output: 'No files on the Canvas.' };
  const listing = ctx.files.map((file, i) => `${i + 1}. ${file.name} — ${file.content.length} chars, origin: ${file.origin}`).join('\n');
  return { id: '', name: 'list_files', ok: true, output: `Canvas files (${ctx.files.length}):\n${listing}` };
}

function executeReadFile(ctx: ExecContext, args: Record<string, string>): ToolResult {
  const name = safeName(args.filename || args.name || args.path || '');
  if (!name) return { id: '', name: 'read_file', ok: false, output: 'read_file requires a valid filename argument, e.g. filename="index.html".' };
  const file = ctx.files.find((item) => item.name === name);
  if (!file) {
    const available = ctx.files.map((f) => f.name).join(', ') || '(none)';
    return { id: '', name: 'read_file', ok: false, output: `No file named ${name} exists on the Canvas. Files: ${available}` };
  }
  const truncated = file.content.length > MAX_FILE_READ;
  const content = truncated ? file.content.slice(0, MAX_FILE_READ) + `\n\n... [truncated, file is ${file.content.length} chars total]` : file.content;
  return {
    id: '', name: 'read_file', ok: true,
    output: `Contents of ${file.name} (origin: ${file.origin}):\n\n\`\`\`\n${content}\n\`\`\``,
  };
}

function executeWriteFile(ctx: ExecContext, args: Record<string, string>): ToolResult {
  const name = safeName(args.filename || args.name || args.path || '');
  if (!name) return { id: '', name: 'write_file', ok: false, output: 'write_file requires a valid filename.' };
  const content = args.content ?? args.body ?? '';
  if (ctx.files.length >= TOTAL_FILES_LIMIT) {
    return { id: '', name: 'write_file', ok: false, output: `Canvas is at the ${TOTAL_FILES_LIMIT}-file limit. Delete an existing file first.` };
  }
  const existing = ctx.files.find((item) => item.name === name);
  const newFiles = existing
    ? ctx.files.map((item) => item.name === name ? { ...item, content, origin: 'generated' as const } : item)
    : [...ctx.files, { id: crypto.randomUUID(), name, content, origin: 'generated' as const }];
  const selected = existing ? ctx.selectedFileId : newFiles[newFiles.length - 1].id;
  return {
    id: '', name: 'write_file', ok: true,
    output: existing ? `Wrote ${content.length} chars to ${name} (replaced previous ${existing.content.length} chars).`
                     : `Created ${name} (${content.length} chars).`,
    files: newFiles, selectedFileId: selected,
  };
}

function executeCreateFile(ctx: ExecContext, args: Record<string, string>): ToolResult {
  const name = safeName(args.filename || args.name || args.path || '');
  if (!name) return { id: '', name: 'create_file', ok: false, output: 'create_file requires a valid filename.' };
  if (ctx.files.some((item) => item.name === name)) {
    return { id: '', name: 'create_file', ok: false, output: `A file named ${name} already exists. Use write_file to overwrite it, or edit_file to change parts.` };
  }
  if (ctx.files.length >= TOTAL_FILES_LIMIT) {
    return { id: '', name: 'create_file', ok: false, output: `Canvas is at the ${TOTAL_FILES_LIMIT}-file limit.` };
  }
  const content = args.content ?? args.body ?? '';
  const file: WorkspaceFile = { id: crypto.randomUUID(), name, content, origin: 'generated' };
  return {
    id: '', name: 'create_file', ok: true,
    output: `Created ${name} (${content.length} chars).`,
    files: [...ctx.files, file], selectedFileId: file.id,
  };
}

function executeEditFile(ctx: ExecContext, args: Record<string, string>): ToolResult {
  const name = safeName(args.filename || args.name || args.path || '');
  if (!name) return { id: '', name: 'edit_file', ok: false, output: 'edit_file requires filename.' };
  const oldText = args.old_value ?? args.find ?? args.before ?? '';
  const newText = args.new_value ?? args.replace ?? args.after ?? '';
  if (!oldText) return { id: '', name: 'edit_file', ok: false, output: 'edit_file needs old_value="…" (exact text to find) and new_value="…" (replacement).' };
  const file = ctx.files.find((item) => item.name === name);
  if (!file) return { id: '', name: 'edit_file', ok: false, output: `No file named ${name}. Read files first with list_files.` };
  if (!file.content.includes(oldText)) {
    const snippet = oldText.length > 80 ? oldText.slice(0, 80) + '…' : oldText;
    return { id: '', name: 'edit_file', ok: false, output: `edit_file could not find the exact text in ${name}: "${snippet}". Re-read the file first to get its current contents; edits must match character-for-character (including whitespace).` };
  }
  const occurrences = file.content.split(oldText).length - 1;
  if (occurrences > 1) {
    return { id: '', name: 'edit_file', ok: false, output: `edit_file found ${occurrences} occurrences of old_value in ${name}. Make old_value more specific (include surrounding lines) so the match is unique.` };
  }
  const updated = file.content.replace(oldText, newText);
  return {
    id: '', name: 'edit_file', ok: true,
    output: `Edited ${name}: replaced ${oldText.length} chars with ${newText.length} chars. File is now ${updated.length} chars.`,
    files: ctx.files.map((item) => item.name === name ? { ...item, content: updated, origin: 'generated' as const } : item),
  };
}

function executeDeleteFile(ctx: ExecContext, args: Record<string, string>): ToolResult {
  const name = safeName(args.filename || args.name || args.path || '');
  if (!name) return { id: '', name: 'delete_file', ok: false, output: 'delete_file requires a filename.' };
  const file = ctx.files.find((item) => item.name === name);
  if (!file) return { id: '', name: 'delete_file', ok: false, output: `No file named ${name} exists.` };
  const newFiles = ctx.files.filter((item) => item.id !== file.id);
  const selected = ctx.selectedFileId === file.id ? (newFiles[0]?.id || null) : ctx.selectedFileId;
  return {
    id: '', name: 'delete_file', ok: true,
    output: `Deleted ${name}.`,
    files: newFiles, selectedFileId: selected,
  };
}

function executeViewPreview(ctx: ExecContext): ToolResult {
  const preview = buildPreview(ctx.files);
  if (!preview) {
    return { id: '', name: 'view_preview', ok: false, output: 'No HTML or SVG file exists to preview. Create an index.html file first.' };
  }
  const total = preview.length;
  const head = preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(0, MAX_PREVIEW_CHARS) + `\n\n... [preview source truncated, total ${total} chars]`
    : preview;
  return {
    id: '', name: 'view_preview', ok: true,
    output: [
      `Rendered preview source (${total} chars). This is the exact sandboxed HTML the user sees, with all Canvas CSS/JS inlined and a strict CSP:`,
      '',
      '```html',
      head,
      '```',
      '',
      'Tip: if the visual output looks wrong, read/edit the source files rather than editing this assembled preview directly.',
    ].join('\n'),
  };
}

export function executeToolCall(call: ToolCall, ctx: ExecContext): ToolResult {
  const base = { id: call.id, name: call.name };
  try {
    switch (call.name) {
      case 'list_files': return { ...base, ...executeListFiles(ctx) };
      case 'read_file': return { ...base, ...executeReadFile(ctx, call.args) };
      case 'write_file': return { ...base, ...executeWriteFile(ctx, call.args) };
      case 'create_file': return { ...base, ...executeCreateFile(ctx, call.args) };
      case 'edit_file': return { ...base, ...executeEditFile(ctx, call.args) };
      case 'delete_file': return { ...base, ...executeDeleteFile(ctx, call.args) };
      case 'view_preview': return { ...base, ...executeViewPreview(ctx) };
    }
  } catch (error) {
    return { ...base, ok: false, output: `Tool error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
