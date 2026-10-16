import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  browse, ipIsBlocked, parseRobots, robotsAllows, extractDesign, toReadableText,
  extractReferences, describeBrowse, collectExternalCss, proxyUrl, BROWSE_USER_AGENT,
} from './browse.mjs';

// ---------------------------------------------------------------------------
// Address safety — the part that keeps this from being an open proxy
// ---------------------------------------------------------------------------

test('private, loopback and metadata addresses are refused', async () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::127.0.0.1',
  ]) {
    assert.equal(ipIsBlocked(ip), true, `${ip} must be blocked`);
  }
});

test('public addresses are allowed', async () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255', '100.63.255.255', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(ipIsBlocked(ip), false, `${ip} must be allowed`);
  }
});

test('non-http schemes and embedded credentials are refused', async () => {
  for (const [url, code] of [
    ['file:///etc/passwd', 'bad_scheme'],
    ['ftp://example.com/x', 'bad_scheme'],
    ['data:text/html,<h1>hi</h1>', 'bad_scheme'],
    ['https://user:pass@example.com/', 'bad_url'],
    ['not a url at all', 'bad_url'],
  ]) {
    await assert.rejects(() => browse(url), (error) => error.code === code, url);
  }
});

test('a name that resolves to a private address is refused', async () => {
  const resolver = { lookup: async () => [{ address: '10.0.0.5', family: 4 }] };
  await assert.rejects(
    () => browse('https://internal.example.com/', { resolver }),
    (error) => error.code === 'blocked_host',
  );
});

test('one private record among several is enough to refuse the host', async () => {
  const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] };
  await assert.rejects(() => browse('https://roundrobin.example.com/', { resolver }), (error) => error.code === 'blocked_host');
});

test('localhost and internal suffixes never need a lookup to refuse', async () => {
  const resolver = { lookup: async () => { throw new Error('should not be consulted'); } };
  for (const host of ['http://localhost/', 'http://something.local/', 'http://metadata/', 'http://[::1]/']) {
    await assert.rejects(() => browse(host, { resolver }), (error) => error.code === 'blocked_host', host);
  }
});

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

test('robots.txt is parsed into groups that share consecutive user-agent lines', () => {
  const groups = parseRobots([
    '# comment',
    'User-agent: GPTBot',
    'User-agent: ClaudeBot',
    'Disallow: /admin/',
    'Allow: /admin/public',
    '',
    'User-agent: *',
    'Disallow: /*?search=*',
    'Disallow: /login$',
  ].join('\n'));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].agents, ['gptbot', 'claudebot']);
  assert.equal(groups[0].rules.length, 2);
  assert.deepEqual(groups[1].agents, ['*']);
});

test('the longest matching rule wins, and Allow beats an equal-length Disallow', () => {
  const groups = parseRobots(['User-agent: *', 'Disallow: /admin/', 'Allow: /admin/public'].join('\n'));
  assert.equal(robotsAllows(groups, '/admin/secret'), false);
  assert.equal(robotsAllows(groups, '/admin/public'), true);

  const tie = parseRobots(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'));
  assert.equal(robotsAllows(tie, '/x'), true);
});

test('robots wildcards and end anchors are honoured', () => {
  const groups = parseRobots(['User-agent: *', 'Disallow: /*?sort=*', 'Disallow: /login$'].join('\n'));
  assert.equal(robotsAllows(groups, '/?sort=featured'), false);
  assert.equal(robotsAllows(groups, '/'), true);
  assert.equal(robotsAllows(groups, '/login'), false);
  assert.equal(robotsAllows(groups, '/login/help'), true, 'the anchor only matches at the end');
});

test('an empty Disallow is not a prohibition', () => {
  assert.equal(robotsAllows(parseRobots(['User-agent: *', 'Disallow:']), '/anything'), true);
});

test('a page the site disallows is never requested', async () => {
  const requested = [];
  await withServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /private/\n'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>secret</h1>');
  }, async (base) => {
    const blocked = await browse(`${base}/private/page`, { allowPrivateAddresses: true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedByRobots, true);
    assert.match(blocked.error, /asks crawlers not to read/);
    assert.equal(requested.includes('/private/page'), false, 'the disallowed page itself was never fetched');

    const allowed = await browse(`${base}/public/page`, { allowPrivateAddresses: true });
    assert.equal(allowed.ok, true, 'a page robots permits still loads');
  });
});

// ---------------------------------------------------------------------------
// Fetching and extraction, against a local server
// ---------------------------------------------------------------------------

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const PERMISSIVE = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); };

test('a redirected page is re-checked, so a public URL cannot bounce to localhost', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    if (req.url === '/start') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    res.writeHead(200); res.end('unreachable');
  }, async (base) => {
    await assert.rejects(() => browse(`${base}/start`, { allowPrivateAddresses: false }), (error) => error.code === 'blocked_host');
  });
});

test('a redirect chain that loops is stopped', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(302, { location: '/b' }); res.end();
  }, async (base) => {
    await assert.rejects(() => browse(`${base}/b`, { allowPrivateAddresses: true }), (error) => error.code === 'redirect_loop');
  });
});

const SAMPLE_PAGE = `<!doctype html><html><head>
<title>Kinetic — Motion design studio</title>
<meta name="description" content="A studio building motion-led interfaces.">
<meta property="og:image" content="https://kinetic.example/og.png">
<meta name="theme-color" content="#0b0b0f">
<meta name="generator" content="Webflow">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Space+Grotesk">
<style>
  :root { --bg: #0b0b0f; --fg: #f5f5f7; --accent: oklch(0.7 0.2 300); --radius: 12px; --gap: 2rem; }
  body { font-family: "Space Grotesk", sans-serif; background: var(--bg); color: #f5f5f7; }
</style>
</head><body>
<nav><a href="/">Home</a></nav>
<section><h1>Motion that means something</h1><p>We design interfaces that move with intent.</p></section>
<section><h2>What we do</h2><h3>Brand systems</h3><p>Systems that scale.</p></section>
<footer><p>© Kinetic</p></footer>
<script>var tracking = 1;</script>
</body></html>`;

test('a real page yields readable text plus its design signals', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SAMPLE_PAGE);
  }, async (base) => {
    const result = await browse(`${base}/`, { allowPrivateAddresses: true });
    assert.equal(result.ok, true);
    assert.equal(result.design.title, 'Kinetic — Motion design studio');
    assert.equal(result.design.description, 'A studio building motion-led interfaces.');
    assert.equal(result.design.framework, 'webflow');
    assert.equal(result.design.themeColor, '#0b0b0f');
    assert.deepEqual(result.design.headings.slice(0, 3), [
      { level: 1, text: 'Motion that means something' },
      { level: 2, text: 'What we do' },
      { level: 3, text: 'Brand systems' },
    ]);
    assert.ok(result.design.fonts.includes('Space Grotesk'), 'the display font is reported');
    assert.equal(result.design.tokens['--accent'], 'oklch(0.7 0.2 300)');
    assert.equal(result.design.tokens['--radius'], '12px');
    assert.equal(result.design.structure.sections, 2);
    assert.ok(result.text.includes('Motion that means something'));
    assert.ok(!result.text.includes('var tracking'), 'scripts are stripped from the text');
  });
});

test('design tokens are read in the forms sites actually use', () => {
  const html = `<html><head><style>:root{
    --brand: #ff5a1f;
    --ink: #111318;
    --accent: oklch(0.7 0.2 300);
    --surface: rgb(11, 11, 15);
    --radius: 14px;
    --step: clamp(2rem, 6vw, 5rem);
    --font-display: "Space Grotesk", sans-serif;
    --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
    --shadow: 0 20px 60px rgba(0,0,0,.4), 0 0 0 1px #fff1;
  }</style></head><body>hi</body></html>`;
  const design = extractDesign(html, 'https://example.com/');
  assert.equal(design.tokens['--brand'], '#ff5a1f', 'hex, the most common form');
  assert.equal(design.tokens['--ink'], '#111318');
  assert.equal(design.tokens['--accent'], 'oklch(0.7 0.2 300)');
  assert.equal(design.tokens['--surface'], 'rgb(11, 11, 15)');
  assert.equal(design.tokens['--radius'], '14px');
  assert.equal(design.tokens['--step'], 'clamp(2rem, 6vw, 5rem)');
  assert.equal(design.tokens['--font-display'], '"Space Grotesk", sans-serif');
  assert.equal(design.tokens['--ease'], 'cubic-bezier(0.2, 0.8, 0.2, 1)');
});

test('the extraction is the same whether the page arrives whole or in pieces', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    for (const piece of SAMPLE_PAGE.match(/[\s\S]{1,64}/g) || []) res.write(piece);
    res.end();
  }, async (base) => {
    const chunked = await browse(`${base}/`, { allowPrivateAddresses: true });
    assert.equal(chunked.design.title, 'Kinetic — Motion design studio');
    assert.equal(chunked.design.tokens['--accent'], 'oklch(0.7 0.2 300)');
  });
});

test('an oversized page is truncated rather than fetched whole', async () => {
  const huge = `<html><head><title>Big</title></head><body>${'x'.repeat(200_000)}</body></html>`;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(huge);
  }, async (base) => {
    const result = await browse(`${base}/`, { allowPrivateAddresses: true, maxBytes: 1_000, textBudget: 500 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 520, 'the readable text is capped too');
  });
});

test('a binary response is reported, not decoded as text', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4');
  }, async (base) => {
    const result = await browse(`${base}/file`, { allowPrivateAddresses: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /application\/pdf/);
  });
});

test('an error status is reported rather than thrown', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    res.writeHead(404); res.end('gone');
  }, async (base) => {
    const result = await browse(`${base}/missing`, { allowPrivateAddresses: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.error, /404/);
  });
});

// ---------------------------------------------------------------------------
// Galleries
// ---------------------------------------------------------------------------

const GALLERY_PAGE = `<html><body>
<a href="/websites/100967-zaro-make-your-company-ai-ready">Zaro</a>
<a href="https://zaro.ai/?ref=land-book.com">Visit</a>
<a href="/login">Sign in</a>
<a href="/design/landing-page">Landing</a>
</body></html>`;

test('a design gallery yields the sites it is featuring', () => {
  const refs = extractReferences(GALLERY_PAGE, 'https://land-book.com/design/landing-page');
  const urls = refs.map((r) => r.url);
  assert.ok(urls.some((url) => url.includes('/websites/100967-zaro')), 'the gallery entry is listed');
  assert.ok(urls.some((url) => url.startsWith('https://zaro.ai/')), 'the outbound site is listed');
  assert.equal(urls.some((url) => url.includes('/design/landing')), false, 'internal navigation is not a reference');
  assert.equal(urls.some((url) => url.includes('/login')), false);
});

test('a generic outbound label is replaced by the site it points at', () => {
  const refs = extractReferences(
    '<a href="https://zaro.ai/?ref=land-book.com">Visit</a><a href="https://getfernand.com/">View site</a><a href="https://reevo.ai/">Reevo</a>',
    'https://land-book.com/',
  );
  const byUrl = Object.fromEntries(refs.map((r) => [r.url, r.name]));
  assert.equal(byUrl['https://zaro.ai/'], 'Zaro', '"Visit" says nothing, so the domain is used');
  assert.equal(byUrl['https://getfernand.com/'], 'Getfernand');
  assert.equal(byUrl['https://reevo.ai/'], 'Reevo', 'a real name is kept as it is');
});

test('a page that is not a gallery yields no references', () => {
  assert.deepEqual(extractReferences(SAMPLE_PAGE, 'https://kinetic.example/'), []);
});

test('the description handed to the model names the site, its tokens and its references', () => {
  const described = describeBrowse({
    ok: true, url: 'https://land-book.com/', finalUrl: 'https://land-book.com/',
    design: { title: 'Landbook', description: 'Curated design gallery', fonts: ['Inter'], colors: ['#0b0b0f'], themeColor: '#0b0b0f', tokens: { '--bg': '#0b0b0f' }, headings: [{ level: 1, text: 'Design inspiration' }], structure: { sections: 4 }, framework: '' },
    text: 'Browse the gallery.',
    references: [{ name: 'Zaro', url: 'https://zaro.ai/' }],
  });
  assert.match(described, /\*\*Landbook\*\*/);
  assert.match(described, /Fonts: Inter/);
  assert.match(described, /--bg: #0b0b0f/);
  assert.match(described, /Sites featured on this page:/);
  assert.match(described, /- Zaro — https:\/\/zaro\.ai\//);
});

test('a failed fetch is described as a failure, not as an empty page', () => {
  assert.match(describeBrowse({ ok: false, url: 'https://x.test/', error: 'responded with 404.' }), /could not read .*responded with 404/);
});

test('readable text collapses markup into lines a model can scan', () => {
  const text = toReadableText('<div><h1>Hi</h1><p>One&amp;two</p><script>noise()</script><p>Three</p></div>');
  assert.match(text, /Hi/);
  assert.match(text, /One&two/, 'entities are decoded');
  assert.doesNotMatch(text, /noise/);
});

test('the crawler identifies itself honestly', () => {
  assert.match(BROWSE_USER_AGENT, /AIFLUX/);
  assert.match(BROWSE_USER_AGENT, /https:\/\//, 'with a contact URL');
});

test('a page whose design system lives in a linked stylesheet is still understood', async () => {
  // Most real sites keep their palette and type scale in external CSS, so a
  // reader that only looked at inline <style> learned almost nothing.
  const CSS = `:root{--brand:#ff5a1f;--ink:#111318;--radius:16px;--step:clamp(2rem,6vw,5rem)}
    body{font-family:"Space Grotesk",sans-serif;background:var(--ink)}`;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    if (req.url === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(CSS); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>External</title><link rel="stylesheet" href="/site.css"></head><body><h1>Hi</h1></body></html>');
  }, async (base) => {
    const result = await browse(`${base}/`, { allowPrivateAddresses: true });
    assert.equal(result.ok, true);
    assert.equal(result.design.tokens['--brand'], '#ff5a1f', 'the palette came from the stylesheet');
    assert.equal(result.design.tokens['--step'], 'clamp(2rem,6vw,5rem)');
    assert.ok(result.design.fonts.includes('Space Grotesk'), 'and so did the display face');
  });
});

test('a stylesheet that will not load does not fail the page', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return PERMISSIVE(req, res);
    if (req.url === '/site.css') { res.writeHead(500); res.end(''); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Broken CSS</title><link rel="stylesheet" href="/site.css"></head><body><h1>Hi</h1></body></html>');
  }, async (base) => {
    const result = await browse(`${base}/`, { allowPrivateAddresses: true });
    assert.equal(result.ok, true, 'the page still reads');
    assert.equal(result.design.title, 'Broken CSS');
  });
});

test('a stylesheet link is held to the same address rules as the page', async () => {
  // A public page linking a private stylesheet is the same SSRF hole as a
  // redirect there, so the link is validated just as hard. Tested on the
  // helper directly: a page served from 127.0.0.1 can only be fetched with
  // the guard lifted, which would lift it for the stylesheet too.
  for (const href of ['http://169.254.169.254/x.css', 'http://127.0.0.1/x.css', 'http://10.0.0.5/x.css']) {
    const html = `<html><head><link rel="stylesheet" href="${href}"></head><body>Hi</body></html>`;
    assert.equal(await collectExternalCss(html, 'https://example.com/', { allowPrivateAddresses: false }), '', href);
  }
  // A stylesheet that simply cannot be fetched fails quietly, not loudly.
  const missing = '<html><head><link rel="stylesheet" href="https://fonts.invalid/x.css"></head></html>';
  assert.equal(await collectExternalCss(missing, 'https://example.com/', { allowPrivateAddresses: false }), '');
});

test('every font in a Google Fonts URL is captured, not just one', () => {
  // A two-face pairing (display + text) is the norm, and a greedy match took
  // only the last family — losing the display face, which is the useful half.
  const html = '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&amp;family=Inter:wght@400;500"></head></html>';
  const design = extractDesign(html, 'https://example.com/');
  assert.ok(design.fonts.includes('Space Grotesk'), 'the display face, which is first');
  assert.ok(design.fonts.includes('Inter'), 'and the text face');
  // Entities must be decoded before splitting, or the separator is left behind.
  assert.ok(!design.fonts.some((font) => font.includes('amp;')), 'no entity fragments survive');
});

test('an outbound link takes the gallery\'s name for that site, not its domain', () => {
  const refs = extractReferences(
    `<a href="/websites/100968-fernand">Fernand</a>
     <a href="https://getfernand.com/?ref=land-book.com">Visit website</a>
     <a href="/websites/100967-zaro">Zaro</a>
     <a href="https://zaro.ai/">Visit website</a>`,
    'https://land-book.com/',
  );
  const byUrl = Object.fromEntries(refs.map((r) => [r.url, r.name]));
  assert.equal(byUrl['https://getfernand.com/'], 'Fernand', 'getfernand.com is named from the gallery entry');
  assert.equal(byUrl['https://zaro.ai/'], 'Zaro');
});

test('a gallery name is not guessed from a short or unrelated domain', () => {
  const refs = extractReferences(
    '<a href="https://x.io/">Visit website</a>',
    'https://land-book.com/',
  );
  assert.equal(refs[0].name, 'X', 'too short to match anything, so the domain stands');
});

test('a slow robots.txt does not starve the page it is gating', async () => {
  // robots.txt was allowed five of the six seconds, so a site that took four
  // seconds to serve it left the page to time out — which reads, from the
  // outside, exactly like the site refusing us.
  const pageMs = 3_000;
  const robotsMs = 4_000;
  const started = Date.now();
  const result = await withServer((req, res) => {
    const delay = req.url === '/robots.txt' ? robotsMs : pageMs;
    setTimeout(() => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Slow to permit, quick to serve</title></head><body>Hello</body></html>');
    }, delay);
  }, async (base) => browse(`${base}/`, { timeoutMs: 6_000, allowPrivateAddresses: true }));
  assert.equal(result.ok, true, 'the page is read despite the slow robots.txt');
  assert.match(result.design.title, /Slow to permit/);
  assert.ok(Date.now() - started < 6_000, 'and inside the budget');
});

test('the fetcher announces itself without tripping a generic bot filter', () => {
  // Land-book welcomes AI crawlers in robots.txt and publishes an llms.txt for
  // them, yet returned 403. The old user-agent contained the bare word "Bot",
  // which is the token generic filters match on and then allowlist around — so
  // a client that names itself was refused by a rule meant for clients that
  // hide. The compatible form states plainly that we are not a browser.
  assert.match(BROWSE_USER_AGENT, /AIFLUX/, 'still names itself');
  assert.match(BROWSE_USER_AGENT, /https:\/\//, 'with a contact URL');
  assert.doesNotMatch(BROWSE_USER_AGENT, /\bbot\b/i, 'without the token filters key on');
  assert.doesNotMatch(BROWSE_USER_AGENT, /curl|python|scrapy|headless/i, 'and never posing as something else');
});

test('requests carry the headers a document request carries', async () => {
  // A filter judging whether a request is from a script reads the whole set,
  // not just the user-agent.
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>${req.headers['accept-language'] ? 'has-lang' : 'bare'}</title></head><body>${req.headers['sec-fetch-dest'] || ''}</body></html>`);
  }, async (base) => {
    const result = await browse(`${base}/`, { allowPrivateAddresses: true });
    assert.equal(result.design.title, 'has-lang', 'accept-language is sent');
    assert.match(result.text, /document/, 'and sec-fetch-dest says document, not subresource');
  });
});

test('fetches can be routed through a relay the operator configures', () => {
  // A host that answers a serverless address with 403 regardless of how the
  // request identifies itself leaves nothing for us to change. The fix belongs
  // to whoever runs the deployment, so it is theirs to set.
  const saved = process.env.AIFLUX_FETCH_PROXY;
  try {
    delete process.env.AIFLUX_FETCH_PROXY;
    assert.equal(proxyUrl('https://example.com/a'), 'https://example.com/a', 'unchanged by default');
    process.env.AIFLUX_FETCH_PROXY = 'https://relay.example/?url=';
    assert.equal(proxyUrl('https://example.com/a'), 'https://relay.example/?url=https://example.com/a', 'appended when there is no placeholder');
    process.env.AIFLUX_FETCH_PROXY = 'https://relay.example/?target={url}';
    assert.match(proxyUrl('https://example.com/a'), /^https:\/\/relay\.example\/\?target=https%3A%2F%2Fexample\.com%2Fa$/, 'encoded where {url} is named');
  } finally {
    if (saved === undefined) delete process.env.AIFLUX_FETCH_PROXY;
    else process.env.AIFLUX_FETCH_PROXY = saved;
  }
});
