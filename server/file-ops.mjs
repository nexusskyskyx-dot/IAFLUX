/**
 * Reads AIFLUX file operations out of a model's token stream.
 *
 * The assistant writes files by emitting tagged blocks instead of dumping code
 * into the chat. Tags are used rather than tool calling because every provider
 * in the app — including the free models — can emit text, while tool support
 * varies. The parser is incremental: a tag may be split across any number of
 * streamed chunks, and prose between blocks must still reach the chat in order.
 *
 *   <aiflux-write path="src/App.tsx">full file contents</aiflux-write>
 *   <aiflux-patch path="src/App.tsx">
 *   <<<<<<< SEARCH
 *   old lines
 *   =======
 *   new lines
 *   >>>>>>> REPLACE
 *   </aiflux-patch>
 *   <aiflux-delete path="src/old.js" />
 *
 * Models do not always use our tag. They fall back on wrapper tags they saw in
 * training — <document>, <file>, <artifact> — so those are accepted too: with a
 * path they become a write, and without one the wrapper is dropped and the body
 * passes through as prose, where the fenced-block fallback can still find it.
 */

const AIFLUX_TAGS = ['aiflux-write', 'aiflux-patch', 'aiflux-delete'];
const VARIANT_TAGS = ['document', 'file', 'artifact'];
/**
 * Pseudo tool calls agentic models invent when they want data they were not
 * given — `<url_fetch>`, `<read_file>`, `<tool_call>` and friends. AIFLUX has no
 * such capability, so the invocation is dropped rather than shown to the user.
 */
const IGNORED_TAGS = ['url_fetch', 'fetch_url', 'urlfetch', 'read_file', 'file_read', 'get_file', 'tool_call', 'tool_use', 'function_call', 'browse', 'web_fetch'];
const TAG_NAMES = [...AIFLUX_TAGS, ...VARIANT_TAGS, ...IGNORED_TAGS];
const OPEN_TAG = new RegExp(`<(${TAG_NAMES.join('|')})\\b([^>]*)>`, 'i');
/** A nested operation inside a block means the model re-opened a tag it was in. */
const NESTED_OP = /<aiflux-(write|patch|delete)\b/i;

/** Guard against a model that opens a block and never closes it. */
const MAX_BLOCK_CHARS = 400_000;

const MAX_HOLD = 1_024;
/** Tag names may contain letters, digits, underscores, dots and dashes. */
const TAG_NAME = /^[a-z_][\w.-]*$/i;

/**
 * Chars to hold back so a tag split across chunks is not emitted as content.
 *
 * The tricky part is a trailing `<`: it may be the start of a tag that is
 * still arriving, or ordinary prose like `a < b`. Hold only what really could
 * still become one of our tags — a bare bracket, a name still being typed, or
 * a recognised name awaiting its `>`. Everything else flows straight through.
 */
function tagFragmentHold(text) {
  const at = text.lastIndexOf('<');
  if (at < 0) return 0;
  const tail = text.slice(at);
  if (tail.length > MAX_HOLD || tail.includes('>')) return 0;
  const body = tail.replace(/^<\/?/, '');
  if (!body) return tail.length; // a bracket that arrived on its own
  if (/^\s/.test(body)) return 0; // `< b` is a comparison, not a tag
  const name = body.split(/[\s"'=]/)[0];
  if (!name) return tail.length;
  // Still typing the name: it could grow into anything.
  if (name === body) return TAG_NAME.test(name) ? tail.length : 0;
  // Past the name: only wait if it is one we actually handle.
  return TAG_NAMES.some((known) => known.startsWith(name.toLowerCase())) ? tail.length : 0;
}

function attribute(attrs, name) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i'));
  if (!match) return '';
  return match[2] ?? match[3] ?? match[4] ?? '';
}

/** Models label the target with `path`, `file`, `filename` or `name`. */
function pathOf(attrs) {
  for (const key of ['path', 'file', 'filename', 'name']) {
    const value = attribute(attrs, key);
    if (value) return value.trim();
  }
  return '';
}

/** A filename the model wrote as a leading comment, if it wrote one. */
function commentFilename(content) {
  const match = content.match(/^\s*(?:\/\/|#|<!--)\s*(?:file(?:name)?\s*[:=]\s*)?([\w./-]+\.[a-z\d]+)/i);
  return match ? match[1] : '';
}

/** Best-effort language for a body that arrived with no language of its own. */
function guessLanguage(content) {
  if (/^\s*(<!doctype html|<html[\s>])/i.test(content)) return 'html';
  if (/^\s*<svg[\s>]/i.test(content)) return 'svg';
  if (/^\s*[.#@][\w-]+[^{;]*\{/m.test(content) && /[};]\s*$/.test(content)) return 'css';
  if (/^\s*[{[]/.test(content) && /[}\]]\s*$/.test(content)) return 'json';
  if (/^\s*(from |import |def |class )\w/m.test(content)) return 'py';
  if (/^\s*(import |export |function |const |let |var |=>)/m.test(content)) return 'js';
  return 'txt';
}

/**
 * Splits patch bodies into SEARCH/REPLACE hunks. Line-based rather than one
 * regex so that empty search text (a pure insertion) and empty replacement
 * text (a pure deletion) both parse predictably.
 */
export function parseHunks(body) {
  const lines = body.split('\n');
  const hunks = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^<{7,}\s*SEARCH\b/.test(lines[index])) { index += 1; continue; }
    index += 1;
    const search = [];
    while (index < lines.length && !/^={7,}/.test(lines[index])) { search.push(lines[index]); index += 1; }
    if (index >= lines.length) break; // Unterminated: drop the partial hunk.
    index += 1; // the ======= separator
    const replace = [];
    while (index < lines.length && !/^>{7,}\s*REPLACE\b/.test(lines[index])) { replace.push(lines[index]); index += 1; }
    if (index >= lines.length) break;
    index += 1; // the >>>>>>> terminator
    hunks.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  return hunks;
}

export function createFileOpParser({ onText, onOp, maxBlock = MAX_BLOCK_CHARS } = {}) {
  let buffer = '';
  let block = null; // { tag, action, path, raw, body }

  const emit = (text) => { if (text) onText(text); };

  function openBlock(tag, attrs, raw) {
    if (tag === 'aiflux-delete') {
      onOp({ action: 'delete', path: pathOf(attrs), status: 'done', raw });
      return;
    }
    // A pseudo tool call is discarded whole: showing the user a fabricated
    // endpoint they cannot call is worse than showing nothing.
    if (IGNORED_TAGS.includes(tag)) { block = { tag, action: 'ignore', path: '', raw, body: '' }; return; }
    const path = pathOf(attrs);
    // A variant wrapper only becomes a file when the model named the target.
    // Otherwise it is transparent: the body flows through as ordinary prose.
    const action = tag === 'aiflux-write' ? 'write' : tag === 'aiflux-patch' ? 'patch' : path ? 'write' : 'transparent';
    block = { tag, action, path, raw, body: '' };
  }

  function closeBlock(closeRaw) {
    const { tag, action, path, raw, body } = block;
    const full = raw + body + closeRaw;
    block = null;
    if (action === 'ignore') return;
    if (action === 'transparent') {
      // A wrapper the model chose for itself. The tags are dropped and the body
      // is re-emitted as a *named* fenced block, so the client's fenced-block
      // fallback turns it into a canvas file and can strip it from the chat.
      const content = body.replace(/^\n/, '').replace(/\n$/, '');
      if (!content.trim()) return;
      // Already fenced: wrapping again would mangle it, so let the client's
      // fenced-block fallback handle the inner block as it stands.
      if (/```/.test(content)) { emit(`\n${content}\n`); return; }
      const language = guessLanguage(content);
      const name = commentFilename(content) || (language === 'html' ? 'index.html' : `snippet.${language}`);
      emit(`\n\`\`\`${language} filename="${name}"\n${content}\n\`\`\`\n`);
      return;
    }
    if (action === 'write' || action === 'patch') {
      if (NESTED_OP.test(body)) {
        // The model re-opened a tag instead of continuing inside it. Writing
        // that out would corrupt the file, so refuse and say why.
        onOp({ action, path, status: 'invalid', error: `The block for ${path || 'the file'} contained a second opening tag.`, raw: full });
        return;
      }
    }
    onOp(action === 'write'
      ? { action: 'write', path, content: body.replace(/^\n/, '').replace(/\n$/, ''), status: 'done', raw: full }
      : { action: 'patch', path, hunks: parseHunks(body), status: 'done', raw: full });
  }

  function drain(final) {
    for (;;) {
      if (!block) {
        const limit = buffer.length - (final ? 0 : tagFragmentHold(buffer));
        const found = OPEN_TAG.exec(buffer.slice(0, Math.max(0, limit)));
        if (!found) {
          if (limit <= 0) return;
          emit(buffer.slice(0, limit));
          buffer = buffer.slice(limit);
          return;
        }
        if (found.index > 0) { emit(buffer.slice(0, found.index)); buffer = buffer.slice(found.index); continue; }
        const tag = found[1].toLowerCase();
        const attrs = found[2] ?? '';
        buffer = buffer.slice(found[0].length);
        openBlock(tag, attrs, found[0]);
        continue;
      }

      const close = new RegExp(`</${block.tag}\\s*>`, 'i').exec(buffer);
      if (!close) {
        const limit = buffer.length - (final ? 0 : tagFragmentHold(buffer));
        if (limit > 0) { block.body += buffer.slice(0, limit); buffer = buffer.slice(limit); }
        if (block.body.length > maxBlock) {
          // Runaway block: hand the text back rather than buffering forever.
          emit(block.raw + block.body);
          block = null;
        }
        return;
      }
      block.body += buffer.slice(0, close.index);
      buffer = buffer.slice(close.index + close[0].length);
      closeBlock(close[0]);
    }
  }

  return {
    push(text) { if (text) { buffer += text; drain(false); } },
    /** Flushes buffered prose and reports any block the stream left open. */
    end() {
      drain(true);
      if (block) {
        // A transparent wrapper is only decorative, so its text is prose.
        // An ignored pseudo call is dropped along with its tag, closed or not.
        // A transparent wrapper is only decorative, so its text is prose.
        // An ignored pseudo call is dropped along with its tag, closed or not.
        if (block.action === 'transparent') emit(block.body);
        // An AIFLUX block is incomplete: never applied to a file, but the raw
        // text is returned so the client can resume exactly where it stopped.
        else if (block.action !== 'ignore') {
          onOp({ action: block.action, path: block.path, status: 'incomplete', raw: block.raw + block.body });
        }
        block = null;
      }
      if (buffer) { emit(buffer); buffer = ''; }
    },
  };
}
