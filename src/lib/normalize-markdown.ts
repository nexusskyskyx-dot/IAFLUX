// Normalizes assistant text so that Markdown that models emit actually renders.
// Models — especially free-tier ones — frequently produce "almost Markdown"
// with Unicode punctuation, invisible formatting characters, or raw HTML tags/
// entities they expect the client to render. This helper:
//   1. Strips invisible / directionality / zero-width characters.
//   2. Replaces Unicode variants of *, _, `, ~, |, #, - and spaces with their
//      ASCII equivalents so **bold**, ### headings, - lists and tables parse.
//   3. Converts common inline HTML tags (<br>, <br/>, <hr>, <b>, <i>, <em>,
//      <strong>, <code>) to Markdown equivalents, and decodes the HTML entities
//      models overuse (&amp; &lt; &gt; &nbsp; &quot; &#8212; etc.) so they show
//      as actual characters instead of literal &amp; strings.
// It deliberately does NOT allow arbitrary HTML — we convert a small allowlist
// and escape the rest, which keeps the preview sanitised.

const BLOCK_HTML_TO_NEWLINES: [RegExp, string][] = [
  [/<br\s*\/?>/gi, '\n'],
  [/<hr\s*\/?>/gi, '\n\nHR_PLACEHOLDER\n\n'],
  [/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n'],
  [/<\/(?:ul|ol|table|thead|tbody)>/gi, '\n\n'],
];

const INLINE_HTML_TO_MD: [RegExp, string | ((...args: string[]) => string)][] = [
  // Paired tags — require a word boundary AFTER the tag name so "<br>" does
  // not match as a "<b>" with trailing "r>".
  [/<(strong|b)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag, inner) => `**${inner}**`],
  [/<(em|i)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag, inner) => `*${inner}*`],
  [/<code(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/code\s*>/gi, (_m, inner) => `\`${inner}\``],
  [/<a(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*href=["']([^"']+)["'](?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/a\s*>/gi, (_m, href, text) => `[${text.trim()}](${href})`],
  // Any stray leftover opening/closing tags (e.g. unclosed <b>) become markers.
  [/<\/?(?:strong|b)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '**'],
  [/<\/?(?:em|i)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '*'],
  [/<\/?code(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '`'],
];

// Map of "lookalike" Unicode punctuation back to ASCII so Markdown parsers see
// the delimiters they expect.
const UNICODE_TO_ASCII: Record<string, string> = {
  '\uFF0A': '*',   // FULLWIDTH ASTERISK
  '\u2217': '*',   // ASTERISK OPERATOR
  '\u2731': '*',   // HEAVY ASTERISK
  '\u204E': '*',   // LOW ASTERISK
  '\uFF3F': '_',   // FULLWIDTH LOW LINE
  '\uFF5E': '~',   // FULLWIDTH TILDE
  '\u223C': '~',   // TILDE OPERATOR
  '\u00B4': "'",   // ACUTE ACCENT (when used for inline code)
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\uFF02': '"', '\uFF07': "'",
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-', '\uFF0D': '-',
  '\uFF5C': '|',   // FULLWIDTH VERTICAL LINE
  '\uFF03': '#',   // FULLWIDTH NUMBER SIGN
  '\u3000': ' ',   // IDEOGRAPHIC SPACE
  '\u00A0': ' ',   // NO-BREAK SPACE
  '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u2000': ' ', '\u2001': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ',
  '\u00AD': '',    // SOFT HYPHEN
  '\uFEFF': '',    // ZERO WIDTH NO-BREAK SPACE / BOM
  '\u200B': '',    // ZERO WIDTH SPACE
  '\u200C': '', '\u200D': '', '\u2060': '', // ZW non-joiners / word joiner
};

// Drop formatting-direction / isolate characters that can confuse the parser.
const BIDIRECTIONAL_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Decode numeric and the most common named HTML entities. We don't need a full
// entity map — models overuse a small set when they escape safe characters.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'",
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', raquo: '»', laquo: '«',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// Drop any other raw HTML tags (don't render them, don't show the angle
// brackets) — but keep their text content. Handles simple self-closing and
// paired tags. Anything malformed falls through to an entity-escaped form.
function stripUnknownTags(text: string): string {
  // Self-closing / void tags we don't have an explicit rule for (img, input,
  // meta, …) get removed entirely.
  text = text.replace(/<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*)?\/>/g, '');
  // Paired tags: replace opening and closing tags, keep inner text. Re-run
  // until fixed-point to handle nesting.
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^<>]*)?>([\s\S]*?)<\/\1>/g, '$2');
  }
  // Any leftover lone `<...>` fragment (malformed) — escape it to text.
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text;
}

export function normalizeMarkdown(input: string): string {
  if (!input) return input;
  let text = input;

  // 1. Remove bidi / zero-width / invisible junk.
  text = text.replace(BIDIRECTIONAL_CHARS, '');

  // 2. Normalize Unicode punctuation lookalikes.
  let out = '';
  for (const ch of text) out += UNICODE_TO_ASCII[ch] ?? ch;
  text = out;

  // 3. Convert allow-listed block HTML to newlines/Markdown.
  for (const [re, replacement] of BLOCK_HTML_TO_NEWLINES) text = text.replace(re, replacement);

  // 4. Convert allow-listed inline HTML to Markdown equivalents.
  for (const [re, replacement] of INLINE_HTML_TO_MD) {
    text = text.replace(re, replacement as string);
  }

  // 5. Strip any other HTML tags (preserving their text content) so we don't
  // render random markup the model invents.
  text = stripUnknownTags(text);

  // 6. Decode HTML entities the model emitted literally.
  text = decodeEntities(text);

  // 7. Collapse runs of more than 2 blank lines; tidy trailing spaces.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  // 8. Ensure headings have one space after the hashes (models sometimes write
  // "#Heading" or use a NBSP) — react-markdown won't recognize them otherwise.
  text = text.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');

  // 9. Ensure list markers are followed by a space. A valid list marker:
  //      * starts a line (with optional indentation),
  //      * is a single `-`, `+`, `*`, or digit+dot,
  //      * is followed by a space AND a non-marker character — so inline
  //        emphasis like "*z*" (which has no space after the marker) and
  //        thematic breaks like "---" are left alone.
  text = text.replace(/^(\s*)([-*+])( +)(?=[^-*+\s])/gm, '$1$2$3'); // already spaced → no-op
  text = text.replace(/^(\s*)([-*+])(?=[A-Za-z0-9\[\]("`'])(?!\S*\*$)/gm, '$1$2 ');
  text = text.replace(/^(\s*)(\d+\.)(?=[A-Za-z0-9\[\]("`'])/gm, '$1$2 ');

  // 10. Replace the <hr> placeholder (inserted before list normalization so it
  //     wouldn't get turned into a list item).
  text = text.replace(/HR_PLACEHOLDER/g, '---');

  return text.trim();
}
