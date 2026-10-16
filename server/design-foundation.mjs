/**
 * A foundation of real CSS, derived from the pages the server just opened.
 *
 * The playbook says what good looks like. The references say whose work to look
 * at. Neither gets a model that writes weak CSS to write good CSS, because
 * writing good CSS is precisely the skill it lacks — and a page built on weak
 * CSS reads as generic no matter how good the advice above it was. Copying is a
 * far smaller ask than composing, so this hands over a foundation already
 * assembled from the palette and the type pairing of the sites above: tokens,
 * scale, section rhythm, one reveal. The model adapts a design instead of
 * inventing one.
 *
 * The risk is monotony — every page inheriting the same shell. It is managed two
 * ways. The tokens are read from the reference sites, so the palette and the
 * fonts change with the request; and when nothing could be read they are drawn
 * from a set of palettes picked by hashing the request, so two different briefs
 * do not land on the same one. What stays fixed is the structure, which is the
 * part that is hard to get right and rarely worth reinventing.
 */

/** Faces that read as body copy rather than display type. */
const TEXT_FACE = /^(inter|roboto|open sans|ibm plex sans|work sans|dm sans|manrope|nunito|nunito sans|lato|source sans(?: pro)?|system-ui|helvetica neue|arial|segoe ui|noto sans|karla|epilogue|figtree|public sans)$/i;

/** Not a real family name, whatever the page called it. */
const GENERIC_FACE = /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|inherit|initial|unset|currentcolor|sans|mono)$/i;

/**
 * Used when no reference could be read. A page still deserves a real palette
 * and a real type pairing, and these are varied enough that two briefs asked
 * back to back do not produce the same page twice.
 */
const DEFAULT_PALETTES = Object.freeze([
  { surface: '#111318', text: '#f4f4f6', accent: '#ff5a1f', display: 'Space Grotesk', body: 'Inter' },
  { surface: '#faf9f7', text: '#191a18', accent: '#1f5f4b', display: 'Fraunces', body: 'Inter' },
  { surface: '#0b0b12', text: '#ecebf5', accent: '#8b5cf6', display: 'Sora', body: 'Inter' },
  { surface: '#f5efe6', text: '#2b2119', accent: '#c2410c', display: 'Bricolage Grotesque', body: 'Inter' },
  { surface: '#0d1117', text: '#e6edf3', accent: '#22d3ee', display: 'Outfit', body: 'Inter' },
]);

function hash(value = '') {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return Math.abs(result);
}

/** Hex or rgb() to components, or null when it is neither. */
export function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.slice(0, 3).split('').map((d) => d + d).join('');
    }
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  const fn = text.match(/^rgba?\(([^)]*)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2] };
}

function toHsl({ r, g, b }) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l, chroma: 0 };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l, chroma: d };
}

const hexOf = ({ r, g, b }) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

function mix(from, to, amount) {
  const a = parseColor(from); const b = parseColor(to);
  if (!a || !b) return from;
  return hexOf({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

/**
 * A value is coming from a page we do not control and is going into a prompt.
 * Anything that could close the block, open a new rule, or pull a remote
 * resource is replaced rather than escaped: there is no reason for a token
 * value to contain those characters.
 */
function safeValue(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 64) return fallback;
  if (/[<>{}\\;@]|url\(|\/\*|\*\//i.test(text)) return fallback;
  return text;
}

/** Google Fonts wants the family name URL-encoded, and nothing else. */
function fontQuery(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '+');
}

/** Split a font list into a display face and a text face. */
export function pickFonts(fonts = []) {
  const clean = [];
  for (const font of fonts) {
    const name = String(font ?? '').split(',')[0].replace(/["']/g, '').trim();
    if (!name || name.length > 32 || GENERIC_FACE.test(name)) continue;
    if (clean.some((kept) => kept.toLowerCase() === name.toLowerCase())) continue;
    clean.push(name);
  }
  const displayFace = clean.find((name) => !TEXT_FACE.test(name)) || null;
  const bodyFace = clean.find((name) => TEXT_FACE.test(name) && name !== displayFace) || null;
  // One family is a legitimate pairing, not a missing one: Inter at 700 and
  // -0.03em is a display face. Better the site's own face in both slots than a
  // stranger's font in one.
  return { display: displayFace || bodyFace, body: bodyFace || displayFace };
}

/** Every colour-ish value a page gave us, from its palette and its tokens. */
function candidateColors(design = {}) {
  const values = [
    ...(Array.isArray(design.colors) ? design.colors : []),
    design.themeColor || '',
    ...Object.values(design.tokens || {}),
  ];
  return values.map(parseColor).filter(Boolean).map((color) => ({ ...color, ...toHsl(color) }));
}

/** The nearest thing to a named radius or shadow in a page's tokens. */
function tokenMatching(design, pattern) {
  for (const [name, value] of Object.entries(design.tokens || {})) {
    if (pattern.test(name)) return safeValue(value, '');
  }
  return '';
}

/**
 * Choose a surface, a text colour and one accent from a page's colours.
 * Preference is given to the most saturated usable colour for the accent and to
 * the most neutral extreme for the surface, which is how these palettes are
 * actually built: one loud colour, one quiet ground.
 */
export function pickPalette(design = {}) {
  // Near-white and near-black are backgrounds, not absences, so the window
  // reaches closer to each end than a colour picker would.
  const pool = candidateColors(design).filter((c) => c.l > 0.02 && c.l < 0.98);
  if (!pool.length) return null;

  const ground = pickSurface(design, pool);
  const candidates = pool.filter((c) => c !== ground && c.chroma >= 0.12);
  if (!candidates.length) return null; // a page with no accent has nothing to borrow
  const accent = [...candidates].sort((a, b) => (b.chroma - a.chroma) || (Math.abs(b.l - 0.55) - Math.abs(a.l - 0.55)))[0];

  const dark = ground.l < 0.45;
  const surface = hexOf(ground);
  return {
    surface,
    text: dark ? '#f2f2f4' : '#141518',
    accent: hexOf(accent),
    onAccent: accent.l > 0.62 ? '#101010' : '#ffffff',
    elevated: dark ? mix(surface, '#ffffff', 0.06) : mix(surface, '#000000', 0.04),
    line: dark ? 'rgb(255 255 255 / 0.10)' : 'rgb(0 0 0 / 0.10)',
    radius: tokenMatching(design, /radius|rounded|corner/) || '16px',
    shadow: tokenMatching(design, /shadow|elevation/) || '0 24px 60px -24px rgb(0 0 0 / 0.35)',
  };
}

/**
 * What the page is drawn on. Guessing this wrong is the visible failure — call
 * the accent the background and every section is flooded with it — so the
 * sources are read in order of how directly each one answers the question:
 * a token that names itself, then the declared theme colour, then inference.
 */
function pickSurface(design, pool) {
  const named = tokenMatching(design, /(surface|background|bg|canvas|paper)(-|$)/i);
  if (named) {
    const parsed = parseColor(named);
    if (parsed) return { ...parsed, ...toHsl(parsed) };
  }
  const theme = parseColor(design.themeColor);
  if (theme) {
    const parsed = { ...theme, ...toHsl(theme) };
    if (parsed.chroma < 0.08) return parsed; // a saturated theme colour is branding, not a ground
  }
  const neutrals = pool.filter((c) => c.chroma < 0.08);
  // Whichever neutral sits furthest from mid-grey is the ground. Ties go to the
  // darker one: a dark surface is the more common choice for this kind of page,
  // and a wrong light guess looks washed out where a wrong dark one still reads.
  return [...(neutrals.length ? neutrals : pool)]
    .sort((a, b) => (Math.abs(b.l - 0.5) - Math.abs(a.l - 0.5)) || (a.l - b.l))[0];
}

function foundationCss() {
  return `*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--surface);color:var(--text);font-family:var(--body);font-size:1.0625rem;line-height:1.65;-webkit-font-smoothing:antialiased}
img,svg,video{max-width:100%;height:auto;display:block}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.wrap{width:min(100% - 2.5rem,1200px);margin-inline:auto}
section{padding:clamp(4.5rem,10vw,9rem) 0}
h1,h2,h3{font-family:var(--display);font-weight:600;line-height:1.04;letter-spacing:-.03em;text-wrap:balance}
h1{font-size:clamp(2.75rem,7vw,6.5rem)}
h2{font-size:clamp(1.75rem,3.5vw,2.75rem)}
h3{font-size:1.25rem;line-height:1.25;letter-spacing:-.02em}
p{text-wrap:pretty;max-width:62ch}
.eyebrow{font-size:.6875rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;padding:.9rem 1.5rem;border:0;border-radius:999px;cursor:pointer;transition:transform .16s ease}
.btn:hover{transform:translateY(-2px)}
.card{background:var(--elevated);border:1px solid var(--line);border-radius:var(--radius);padding:clamp(1.5rem,3vw,2.5rem)}
.grid{display:grid;gap:clamp(1rem,2vw,1.5rem)}
/* Visible by default: the hidden state is only ever switched on by the script
   below, so a page whose JavaScript never runs still shows every section, and
   a reader who asked for reduced motion is never hidden from at all. */
.reveal{opacity:1}
@media (prefers-reduced-motion:no-preference){
  .reveal.reveal-on{opacity:0;transform:translateY(24px);transition:opacity .52s cubic-bezier(.2,.8,.2,1),transform .52s cubic-bezier(.2,.8,.2,1)}
  .reveal.reveal-on.in{opacity:1;transform:none}
}`;
}

/**
 * The foundation block, or '' when there is nothing to say. Takes the designs
 * of the pages that were opened, most useful first.
 */
export function buildDesignFoundation({ designs = [], text = '' } = {}) {
  const opened = (Array.isArray(designs) ? designs : []).filter(Boolean);
  let palette = null;
  let fonts = { display: null, body: null };
  for (const design of opened) {
    if (!palette) palette = pickPalette(design);
    const found = pickFonts(design.fonts || []);
    fonts = { display: fonts.display || found.display, body: fonts.body || found.body };
    if (palette && fonts.display && fonts.body) break;
  }

  const fallback = DEFAULT_PALETTES[hash(text) % DEFAULT_PALETTES.length];
  const fallbackDark = toHsl(parseColor(fallback.surface)).l < 0.45;
  const display = fontQuery(fonts.display) ? fonts.display : fallback.display;
  const body = fontQuery(fonts.body) && fonts.body !== display ? fonts.body : fallback.body;
  const p = palette || {
    surface: fallback.surface,
    text: fallback.text,
    accent: fallback.accent,
    onAccent: toHsl(parseColor(fallback.accent)).l > 0.62 ? '#101010' : '#ffffff',
    elevated: mix(fallback.surface, fallbackDark ? '#ffffff' : '#000000', 0.06),
    line: fallbackDark ? 'rgb(255 255 255 / 0.10)' : 'rgb(0 0 0 / 0.10)',
    radius: '16px',
    shadow: '0 24px 60px -24px rgb(0 0 0 / 0.35)',
  };

  const unique = [...new Set([display, body].filter(Boolean))];
  const families = unique.length === 1
    ? [`family=${fontQuery(unique[0])}:wght@400;500;600;700`]
    : [`family=${fontQuery(display)}:wght@500;700`, `family=${fontQuery(body)}:wght@400;500`];
  const familiesQuery = families.join('&');
  const origin = palette
    ? 'The palette and the type pairing below were read from the pages above.'
    : 'No reference could be read, so this is a starting palette rather than a borrowed one.';

  return [
    'A FOUNDATION TO BUILD ON — real CSS, not a description of CSS.',
    origin,
    'Use it as the ground floor and change the plan: different sections, a different layout, your own imagery and copy. Do not reproduce these rules unchanged and call it a design.',
    '',
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${familiesQuery}&display=swap">`,
    '',
    '<style>',
    ':root {',
    `  --surface: ${p.surface};`,
    `  --text: ${p.text};`,
    `  --accent: ${p.accent};`,
    `  --on-accent: ${p.onAccent};`,
    `  --elevated: ${p.elevated};`,
    `  --line: ${p.line};`,
    `  --radius: ${p.radius};`,
    `  --shadow: ${p.shadow};`,
    `  --display: "${display}", system-ui, sans-serif;`,
    `  --body: "${body}", system-ui, sans-serif;`,
    '}',
    '',
    foundationCss(),
    '</style>',
    '',
    'Reveal on scroll — add class="reveal" to anything that should rise into place:',
    '<script>',
    'const io=new IntersectionObserver((es)=>es.forEach((e,i)=>{if(e.isIntersecting){e.target.style.transitionDelay=i*70+"ms";e.target.classList.add("in");io.unobserve(e.target)}}),{threshold:.15});',
    'document.querySelectorAll(".reveal").forEach((el)=>{el.classList.add("reveal-on");io.observe(el)});',
    '</script>',
  ].join('\n');
}
