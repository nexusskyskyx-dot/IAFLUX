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
 */

const TAG_PREFIX = '<aiflux-';
const OPEN_TAG = /^<aiflux-(write|patch|delete)\s*([^>]*)>/i;

/** Guard against a model that opens a block and never closes it. */
const MAX_BLOCK_CHARS = 400_000;

function attribute(attrs, name) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i'));
  if (!match) return '';
  return match[2] ?? match[3] ?? match[4] ?? '';
}

/** Length of the longest suffix of `text` that could still grow into `prefix`. */
function tailPrefixLength(text, prefix) {
  const longest = Math.min(prefix.length - 1, text.length);
  for (let size = longest; size > 0; size -= 1) {
    if (text.endsWith(prefix.slice(0, size))) return size;
  }
  return 0;
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
  let block = null; // { action, path, raw, body }

  const emit = (text) => { if (text) onText(text); };

  function drain(final) {
    for (;;) {
      if (!block) {
        const at = buffer.indexOf(TAG_PREFIX);
        if (at < 0) {
          // Hold back a trailing fragment that might yet become a tag.
          const hold = final ? 0 : tailPrefixLength(buffer, TAG_PREFIX);
          const safe = buffer.length - hold;
          if (safe <= 0) return;
          emit(buffer.slice(0, safe));
          buffer = buffer.slice(safe);
          return;
        }
        if (at > 0) { emit(buffer.slice(0, at)); buffer = buffer.slice(at); continue; }

        const open = buffer.match(OPEN_TAG);
        if (!open) {
          if (final) { emit(buffer); buffer = ''; return; }
          // Still plausible: no '>' has arrived, so the tag may be incomplete.
          if (buffer.includes('>')) { emit(TAG_PREFIX); buffer = buffer.slice(TAG_PREFIX.length); continue; }
          return;
        }
        const [, action, attrs] = open;
        const kind = action.toLowerCase();
        buffer = buffer.slice(open[0].length);
        if (kind === 'delete') {
          onOp({ action: 'delete', path: attribute(attrs, 'path'), status: 'done', raw: open[0] });
          continue;
        }
        block = { action: kind, path: attribute(attrs, 'path'), raw: open[0], body: '' };
        continue;
      }

      const close = `</aiflux-${block.action}>`;
      const at = buffer.indexOf(close);
      if (at < 0) {
        // Hold back a tail that could still turn out to be the start of the
        // closing tag; otherwise a tag split across chunks is eaten as content.
        const hold = tailPrefixLength(buffer, close);
        const safe = buffer.length - hold;
        if (safe > 0) { block.body += buffer.slice(0, safe); buffer = buffer.slice(safe); }
        if (block.body.length > maxBlock) {
          // Runaway block: hand the text back rather than buffering forever.
          emit(block.raw + block.body);
          block = null;
        }
        return;
      }
      block.body += buffer.slice(0, at);
      const raw = block.raw + block.body + close;
      buffer = buffer.slice(at + close.length);
      onOp(block.action === 'write'
        ? { action: 'write', path: block.path, content: block.body.replace(/^\n/, '').replace(/\n$/, ''), status: 'done', raw }
        : { action: 'patch', path: block.path, hunks: parseHunks(block.body), status: 'done', raw });
      block = null;
    }
  }

  return {
    push(text) { if (text) { buffer += text; drain(false); } },
    /** Flushes buffered prose and reports any block the stream left open. */
    end() {
      drain(true);
      if (block) {
        // Incomplete: never applied to a file, but the raw text is returned so
        // the client can resume exactly where the model stopped.
        onOp({ action: block.action, path: block.path, status: 'incomplete', raw: block.raw + block.body });
        block = null;
      }
      if (buffer) { emit(buffer); buffer = ''; }
    },
  };
}
