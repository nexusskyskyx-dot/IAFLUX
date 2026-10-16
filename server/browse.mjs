// Reading the web on the model's behalf.
//
// This endpoint fetches a public page from inside the server, where there is no
// CORS and no browser, and hands the model something it can reason about: the
// readable text plus the design signals a static screenshot cannot give you —
// fonts, colour tokens, heading structure, and (on a gallery) the list of
// featured sites.
//
// It is reachable from the public internet, so the dangerous part is not the
// parsing, it is where the request is allowed to go. A server that will fetch
// any URL is a proxy into whatever network it sits on: cloud metadata, internal
// dashboards, databases that trust the local net. Every hop is therefore
// resolved and checked against the private ranges, and redirects are followed
// by hand so a public URL cannot bounce to 127.0.0.1 after the first check.

import dns from 'node:dns/promises';
import net from 'node:net';

export const BROWSE_TIMEOUT_MS = 12_000;
export const BROWSE_MAX_BYTES = 2_000_000;
export const BROWSE_MAX_REDIRECTS = 3;
export const BROWSE_TEXT_BUDGET = 24_000;
export const BROWSE_USER_AGENT = 'AIFLUX-Bot/1.0 (+https://github.com/nexusskyskyx-dot/IAFLUX)';
/** Linked stylesheets to read, and how much of each. */
const STYLESHEET_LIMIT = 2;
const STYLESHEET_BUDGET_BYTES = 200_000;

export class BrowseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Address safety
// ---------------------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// [network address as int, bits]
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, and 169.254.169.254 metadata
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, includes 255.255.255.255
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function v4Blocked(int) {
  return BLOCKED_V4.some(([base, bits]) => {
    if (bits === 0) return true;
    const mask = bits === 32 ? -1 : ((0xffffffff << (32 - bits)) >>> 0);
    return (int & mask) === (base & mask);
  });
}

// Expand an IPv6 address to 16 bytes. Handles :: compression and a trailing
// IPv4 literal (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::1.2.3.4).
function ipv6ToBytes(ip) {
  let text = ip.split('%')[0];
  let tailV4 = null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    tailV4 = tail.split('.').map(Number);
    if (tailV4.length !== 4 || tailV4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = text.slice(0, lastColon + 1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter(Boolean) : []) : [];
  const groups = [...head, ...back].map((h) => parseInt(h, 16));
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const missing = 8 - groups.length - (tailV4 ? 2 : 0);
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const words = halves.length === 2
    ? [...head.map((h) => parseInt(h, 16)), ...Array(missing).fill(0), ...back.map((h) => parseInt(h, 16))]
    : groups;
  const bytes = [];
  for (const word of words) { bytes.push((word >> 8) & 0xff, word & 0xff); }
  if (tailV4) bytes.push(...tailV4);
  return bytes.length === 16 ? bytes : null;
}

function v6Blocked(bytes) {
  if (bytes.every((b) => b === 0)) return true;                          // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true;                           // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;      // fe80::/10
  if (bytes[0] === 0xff) return true;                                    // ff00::/8
  // An IPv4 address carried inside IPv6 must be judged as IPv4, otherwise
  // ::ffff:169.254.169.254 sails straight through the v6 rules.
  const mapped = (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
    || (bytes.slice(0, 12).every((b) => b === 0))
    || (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0));
  if (mapped) return v4Blocked(((bytes[12] << 24) >>> 0) + (bytes[13] << 16) + (bytes[14] << 8) + bytes[15]);
  return false;
}

/** True when this literal IP must never be fetched. */
export function ipIsBlocked(ip) {
  const family = net.isIP(ip);
  if (family === 4) return v4Blocked(ipv4ToInt(ip));
  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    return bytes ? v6Blocked(bytes) : true;
  }
  return true;
}

function hostnameIsBlocked(hostname) {
  // URL.hostname keeps the brackets around a IPv6 literal: [::1] → ::1
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A bare IP literal never needs resolving.
  if (net.isIP(host)) return ipIsBlocked(host);
  return false;
}

/**
 * Reject a URL whose host cannot be proven public. Every address DNS returns
 * for the name has to be public: one private record is enough for an attacker
 * who controls a round-robin entry.
 */
export async function assertPublicUrl(rawUrl, { resolver = dns, allowPrivateAddresses = false } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new BrowseError('bad_url', 'That is not a URL I can open.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowseError('bad_scheme', 'Only http and https pages can be opened.');
  }
  if (url.username || url.password) {
    throw new BrowseError('bad_url', 'URLs carrying credentials are not fetched.');
  }
  if (allowPrivateAddresses) return url;
  if (hostnameIsBlocked(url.hostname)) {
    throw new BrowseError('blocked_host', 'That address is not a public website.');
  }
  let records;
  try {
    records = await resolver.lookup(url.hostname, { all: true });
  } catch {
    throw new BrowseError('dns_failed', `Could not resolve ${url.hostname}.`);
  }
  if (!records.length) throw new BrowseError('dns_failed', `Could not resolve ${url.hostname}.`);
  for (const record of records) {
    if (ipIsBlocked(record.address)) {
      throw new BrowseError('blocked_host', 'That address is not a public website.');
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** Parse a robots.txt body into user-agent groups. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const split = line.indexOf(':');
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one rule group.
      if (current && !current.sealed) current.agents.push(value.toLowerCase());
      else { current = { agents: [value.toLowerCase()], rules: [], sealed: false }; groups.push(current); }
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
      current.sealed = true;
    } else if (field === 'sitemap') {
      continue;
    } else {
      current = null;
    }
  }
  return groups;
}

function pathMatchesRule(pattern, path) {
  // An empty value is not a rule: "Disallow:" alone means "nothing is barred".
  if (!pattern) return false;
  let body = pattern;
  let anchored = false;
  if (body.endsWith('$')) { anchored = true; body = body.slice(0, -1); }
  const source = '^' + body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '');
  try { return new RegExp(source).test(path); } catch { return false; }
}

/**
 * Longest matching rule wins, and an Allow beats a Disallow of equal length,
 * which is how the galleries that publish robots.txt intend it to be read.
 */
export function robotsAllows(groups, path, userAgent = 'aiflux-bot') {
  const names = new Set(['*', userAgent.toLowerCase()]);
  let best = null;
  for (const group of groups) {
    if (!group.agents.some((agent) => names.has(agent))) continue;
    for (const rule of group.rules) {
      if (!pathMatchesRule(rule.path, path)) continue;
      const length = rule.path.length;
      if (!best || length > best.length || (length === best.length && rule.allow)) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best ? best.allow : true;
}

const robotsCache = new Map();
const ROBOTS_TTL_MS = 10 * 60_000;

async function fetchRobots(origin, { fetchImpl, timeoutMs = 5_000 } = {}) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached;
  const entry = { at: Date.now(), groups: [], state: 'allowed' };
  try {
    const response = await (fetchImpl || fetch)(`${origin}/robots.txt`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': BROWSE_USER_AGENT, accept: 'text/plain,*/*' },
    });
    if (response.status === 401 || response.status === 403) entry.state = 'disallowed';
    else if (response.ok) { entry.groups = parseRobots(await response.text()); entry.state = 'parsed'; }
    else entry.state = 'allowed'; // no robots.txt published
  } catch {
    entry.state = 'allowed'; // unreachable robots.txt is not a prohibition
  }
  if (robotsCache.size > 200) robotsCache.clear();
  robotsCache.set(origin, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// HTML → readable text and design signals
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (full, name) => ENTITIES[name.toLowerCase()] ?? full);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function collectStyles(html) {
  const styles = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(match[1]);
  for (const match of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) styles.push(match[1]);
  return styles.join('\n');
}

function topByFrequency(values, limit) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value).trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

const COLOR_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3}|[0-9a-f]{4})\b|(?:\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\([^)]*\))/gi;
const FONT_SOURCE_PATTERN = /fonts\.googleapis\.com\/css2?\?[^"']*family=([^&"']+)/gi;
const FONT_STACK_PATTERN = /(?:^|[{;,\s])font(?:-family)?\s*:\s*([^;{}]+)/gi;
const TOKEN_PATTERN = /--([a-z0-9][a-z0-9-_]*)\s*:\s*([^;{}]+)/gi;
// Keep a custom property whose value is short and free of markup. Colours
// (hex especially — it is how most design systems store a palette), lengths,
// CSS functions, font stacks and shadows are all worth reporting; anything
// carrying selector syntax is debris from the stylesheet, not a token.
const TOKEN_JUNK = /[<>{};@\\]|\n/;
const FRAMEWORK_SIGNATURES = [
  ['webflow', /webflow|\bwf-[a-z]/i],
  ['framer', /framerusercontent\.com|__framer|data-framer/i],
  ['next.js', /\/_next\//i],
  ['nuxt', /\/_nuxt\//i],
  ['astro', /\/_astro\//i],
  ['sveltekit', /__sveltekit/i],
  ['shopify', /cdn\.shopify\.com/i],
  ['wordpress', /wp-content|wp-includes/i],
  ['squarespace', /squarespace/i],
  ['wix', /\bwix\.com|wixstatic/i],
];

/** Pull the design signals worth describing: tokens, type, colour, structure. */
export function extractDesign(html, finalUrl = '', externalCss = '') {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || html.slice(0, 60_000);
  // Almost no real site keeps its design system inline: the palette, the type
  // scale and the spacing live in linked stylesheets. Reading inline <style>
  // alone finds the tokens on a handful of sites and nothing on the rest.
  const css = `${collectStyles(html)}\n${externalCss}`;

  const meta = (name) => {
    const pattern = new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i')
      || new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`, 'i');
    return decodeEntities(html.match(pattern)?.[1] || head.match(pattern)?.[1] || '').trim();
  };

  const fonts = [];
  for (const match of html.matchAll(FONT_SOURCE_PATTERN)) {
    for (const family of decodeEntities(match[1]).split('&')) {
      const name = family.split(':')[0].replace(/\+/g, ' ').trim();
      if (name) fonts.push(name);
    }
  }
  for (const match of css.matchAll(FONT_STACK_PATTERN)) {
    for (const family of match[1].split(',')) {
      const name = family.replace(/^["']|["']$/g, '').replace(/!\s*important/gi, '').trim();
      if (name && !/^(var|inherit|initial|unset|revert)/i.test(name)) fonts.push(name);
    }
  }

  const tokens = {};
  for (const match of css.matchAll(TOKEN_PATTERN)) {
    const name = `--${match[1].toLowerCase()}`;
    const value = decodeEntities(match[2]).trim();
    if (value.length > 80 || !value || TOKEN_JUNK.test(value)) continue;
    if (tokens[name] === undefined) tokens[name] = value;
  }

  const headings = [];
  for (const match of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(match[2]);
    if (text) headings.push({ level: Number(match[1]), text });
  }

  const count = (tag) => (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
  const design = {
    title: stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    description: meta('description') || meta('og:description'),
    ogImage: meta('og:image') || meta('twitter:image'),
    themeColor: meta('theme-color'),
    generator: meta('generator'),
    framework: FRAMEWORK_SIGNATURES.find(([, pattern]) => pattern.test(html))?.[0] || '',
    fonts: topByFrequency(fonts, 8),
    colors: topByFrequency(html.match(COLOR_PATTERN) || css.match(COLOR_PATTERN) || [], 16),
    tokens,
    headings: headings.slice(0, 24),
    structure: {
      sections: count('section'), nav: count('nav'), footer: count('footer'),
      main: count('main'), article: count('article'), buttons: count('button'),
    },
  };
  if (finalUrl) design.url = finalUrl;
  return design;
}

const STRIP_PATTERN = /<\s*(script|style|noscript|svg|iframe|template|canvas|video|audio|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const BLOCK_PATTERN = /<\s*\/?\s*(p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|ul|ol|tr|br|blockquote|pre|hr)\b[^>]*>/gi;

/**
 * The CSS behind a page, from the stylesheets it links to.
 *
 * Redirects are refused rather than followed: the initial URL was checked, but
 * a stylesheet that answers 302 to a private address would otherwise walk
 * straight past the guard.
 */
export async function collectExternalCss(html, baseUrl, options = {}) {
  const { fetchImpl = fetch, resolver = dns, allowPrivateAddresses = false, timeoutMs = 6_000 } = options;
  const urls = [];
  for (const match of html.matchAll(/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi)) {
    const href = decodeEntities(match[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '');
    if (!href) continue;
    let target;
    try { target = new URL(href, baseUrl); } catch { continue; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    urls.push(target.toString());
    if (urls.length >= STYLESHEET_LIMIT) break;
  }
  if (!urls.length) return '';

  const parts = [];
  for (const cssUrl of urls) {
    if (timeoutMs < 1_000) break;
    try {
      const target = await assertPublicUrl(cssUrl, { resolver, allowPrivateAddresses });
      const response = await fetchImpl(target.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(4_000, timeoutMs)),
        headers: { 'user-agent': BROWSE_USER_AGENT, accept: 'text/css,*/*' },
      });
      if (!response.ok) continue;
      const { buffer } = await readCapped(response, STYLESHEET_BUDGET_BYTES);
      parts.push(decodeBody(buffer, response.headers.get('content-type') || 'text/css'));
    } catch {
      // A stylesheet that will not load is not worth failing the page over.
    }
  }
  return parts.join('\n');
}

/** Readable prose: what a person would see if they selected the page. */
export function toReadableText(html, budget = BROWSE_TEXT_BUDGET) {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] || html;
  const withoutChrome = body.replace(STRIP_PATTERN, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeEntities(withoutChrome.replace(BLOCK_PATTERN, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const trimmed = text.length > budget ? `${text.slice(0, budget)}\n… (truncated)` : text;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Galleries: a directory of featured sites, not just one page
// ---------------------------------------------------------------------------

const GALLERY_HOSTS = new Set(['land-book.com', 'www.land-book.com', 'godly.design', 'www.godly.design', 'www.awwwards.com', 'awwwards.com']);

// Galleries label the outbound link "Visit", which tells the model nothing
// about which site it is looking at. Fall back to the domain name instead.
// Galleries say "Visit website", "View site", "See live" and so on. None of
// those name anything, so the domain is used instead. Matched on the first
// word rather than the whole string, because the suffixes vary endlessly.
const GENERIC_LINK_LABELS = /^(visit|view|see|open|go|launch|demo|watch|explore|browse|check|preview|live|website|site|link|read more|learn more|more)\b/i;

/** The words an anchor carries: its text, else its image's alt, else its title. */
function anchorText(inner, attrs) {
  const text = stripTags(inner);
  if (text) return text;
  const alt = decodeEntities(inner.match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i)?.[1] || '').trim();
  // Alt text on a gallery is "Zaro | Make your company AI-ready - Landing
  // design inspiration": the name is the part before the dash or pipe.
  if (alt) return alt.split(/\s+[—–|-]\s+/)[0].trim() || alt;
  return decodeEntities(attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1] || '').trim();
}

function referenceName(label, url) {
  const cleaned = String(label || '').trim();
  if (cleaned && !GENERIC_LINK_LABELS.test(cleaned)) return cleaned;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const first = host.split('.')[0] || host;
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return cleaned || url;
  }
}

/**
 * On a design gallery the valuable content is not the gallery's own copy, it
 * is the list of sites it is showing. Lift those so the model can name real
 * references (and open one) instead of inventing URLs.
 */
export function extractReferences(html, finalUrl) {
  let host = '';
  try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  if (!GALLERY_HOSTS.has(host) && !GALLERY_HOSTS.has(`www.${host}`)) return [];

  const seen = new Set();
  const references = [];
  const pattern = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = decodeEntities(match[2]);
    const label = anchorText(match[4], `${match[1]} ${match[3]}`);
    if (!label || label.length > 120) continue;
    let target;
    try { target = new URL(href, finalUrl); } catch { continue; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;

    const targetHost = target.hostname.replace(/^www\./, '');
    const isSitePage = /\/websites?\//.test(target.pathname) || /\/website\//.test(target.pathname);
    // The outbound link to the site itself, which is what we want to name.
    const isOutbound = !GALLERY_HOSTS.has(target.hostname) && !GALLERY_HOSTS.has(targetHost);
    if (!isSitePage && !isOutbound) continue;
    if (isOutbound) {
      // Galleries tag outbound links with ?ref= and ?utm_*. Drop the tracking,
      // keep the destination — discarding it would lose the actual reference.
      for (const key of [...target.searchParams.keys()]) {
        if (/^(utm_|ref|fbclid|gclid|mc_|igshid|s_kwcid)/i.test(key)) target.searchParams.delete(key);
      }
      target.hash = '';
    }

    const key = `${targetHost}${target.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ name: referenceName(label, target.toString()), url: target.toString(), external: isOutbound });
    if (references.length >= 40) break;
  }
  return references;
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

async function readCapped(response, capBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return { buffer: Buffer.from(await response.arrayBuffer()), truncated: false };
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total > capBytes) return { buffer: Buffer.concat(chunks), truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

function decodeBody(buffer, contentType) {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buffer); } catch { return buffer.toString('utf8'); }
}

/**
 * Fetch one public page and describe it.
 *
 * Options are injectable so the tests can run against a local server without
 * weakening anything the HTTP route relies on.
 */
export async function browse(rawUrl, options = {}) {
  const {
    fetchImpl = fetch, resolver = dns, checkRobots = true, allowPrivateAddresses = false,
    timeoutMs = BROWSE_TIMEOUT_MS, maxBytes = BROWSE_MAX_BYTES, textBudget = BROWSE_TEXT_BUDGET,
  } = options;

  let url = await assertPublicUrl(rawUrl, { resolver, allowPrivateAddresses });
  const deadline = Date.now() + timeoutMs;
  const robotsStates = [];
  const visited = new Set();

  for (let hop = 0; ; hop += 1) {
    if (visited.has(url.toString())) throw new BrowseError('redirect_loop', 'That page redirects in a loop.');
    visited.add(url.toString());

    if (checkRobots) {
      const entry = await fetchRobots(url.origin, { fetchImpl, timeoutMs: Math.min(5_000, timeoutMs) });
      const path = url.pathname + url.search;
      if (entry.state === 'disallowed' || !robotsAllows(entry.groups, path, BROWSE_USER_AGENT)) {
        return {
          url: rawUrl, finalUrl: url.toString(), ok: false, blockedByRobots: true,
          error: `${url.hostname} asks crawlers not to read ${path}. Respecting that.`,
          design: null, text: '', references: [],
        };
      }
      robotsStates.push(`${url.origin}:${entry.state}`);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
        headers: {
          'user-agent': BROWSE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en',
        },
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new BrowseError('timeout', `${url.hostname} took too long to respond.`);
      }
      throw new BrowseError('unreachable', `Could not reach ${url.hostname}.`);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new BrowseError('bad_redirect', 'The page sent a redirect with no destination.');
      if (hop >= BROWSE_MAX_REDIRECTS) throw new BrowseError('too_many_redirects', 'That page redirects too many times.');
      await response.body?.cancel?.().catch(() => {});
      // Re-validate the destination: this is the check a naive fetcher skips.
      url = await assertPublicUrl(new URL(location, url).toString(), { resolver, allowPrivateAddresses });
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      return {
        url: rawUrl, finalUrl: url.toString(), ok: false, status: response.status,
        error: `${url.hostname} responded with ${response.status}.`, design: null, text: '', references: [],
      };
    }
    if (!/text\/|application\/(xhtml|json|\w+\+json)/i.test(contentType)) {
      return {
        url: rawUrl, finalUrl: url.toString(), ok: false,
        error: `${url.hostname} served ${contentType.split(';')[0] || 'a binary file'}, which has no readable text.`,
        design: null, text: '', references: [],
      };
    }

    const { buffer, truncated } = await readCapped(response, maxBytes);
    const html = decodeBody(buffer, contentType);
    const externalCss = await collectExternalCss(html, url.toString(), {
      fetchImpl, resolver, allowPrivateAddresses, timeoutMs: Math.max(1_000, deadline - Date.now()),
    });
    return {
      url: rawUrl,
      finalUrl: url.toString(),
      ok: true,
      status: response.status,
      truncated,
      design: extractDesign(html, url.toString(), externalCss),
      text: toReadableText(html, textBudget),
      references: extractReferences(html, url.toString()),
      robots: robotsStates,
    };
  }
}

/** The shape handed to the model: compact, and honest about what is missing. */
export function describeBrowse(result) {
  if (!result?.ok) return `I could not read ${result?.url || 'that page'}: ${result?.error || 'unknown error'}`;
  const { design = {}, text = '', references = [], finalUrl = '' } = result;
  const lines = [`**${design.title || finalUrl}**`, finalUrl];
  if (design.description) lines.push('', `> ${design.description}`);
  const facts = [];
  if (design.framework || design.generator) facts.push(`Built with: ${design.framework || design.generator}`);
  if (design.fonts?.length) facts.push(`Fonts: ${design.fonts.join(', ')}`);
  if (design.colors?.length) facts.push(`Colours in use: ${design.colors.slice(0, 12).join(' ')}`);
  if (design.themeColor) facts.push(`Theme colour: ${design.themeColor}`);
  const tokenNames = Object.keys(design.tokens || {});
  if (tokenNames.length) {
    facts.push(`Design tokens: ${tokenNames.slice(0, 24).map((name) => `${name}: ${design.tokens[name]}`).join('; ')}`);
  }
  const structure = Object.entries(design.structure || {}).filter(([, value]) => value > 0);
  if (structure.length) facts.push(`Structure: ${structure.map(([key, value]) => `${value} <${key}>`).join(', ')}`);
  if (facts.length) lines.push('', facts.join('\n'));
  if (design.headings?.length) {
    lines.push('', 'Headings:', ...design.headings.slice(0, 12).map((h) => `${'#'.repeat(h.level)} ${h.text}`));
  }
  if (references.length) {
    lines.push('', 'Sites featured on this page:', ...references.slice(0, 30).map((r) => `- ${r.name} — ${r.url}`));
  }
  if (text.trim()) lines.push('', 'Page text:', text.slice(0, 6_000));
  return lines.join('\n');
}
