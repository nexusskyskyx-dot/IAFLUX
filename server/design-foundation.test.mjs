import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDesignFoundation, pickPalette, pickFonts, parseColor } from './design-foundation.mjs';

const DARK = {
  colors: ['#111318', '#ff5a1f', '#f5f5f7'],
  themeColor: '#0b0b0f',
  fonts: ['Space Grotesk', 'Inter'],
  tokens: { '--radius': '16px' },
};
const LIGHT = { colors: ['#faf9f7', '#1f5f4b'], fonts: ['Fraunces', 'Inter'], tokens: {} };

test('a dark site gives a dark surface and its loud colour becomes the accent', () => {
  const palette = pickPalette(DARK);
  assert.equal(palette.surface, '#0b0b0f');
  assert.equal(palette.accent, '#ff5a1f');
  assert.equal(palette.onAccent, '#ffffff', 'white reads on a mid orange');
});

test('near-white paper is a surface, not an accent', () => {
  // HSL saturation calls #faf9f7 about 22% saturated, so a saturation test
  // rejected it and the green became both surface and accent. Absolute chroma
  // is what actually separates paper from colour.
  const palette = pickPalette(LIGHT);
  assert.equal(palette.surface, '#faf9f7');
  assert.equal(palette.accent, '#1f5f4b');
  assert.equal(palette.text, '#141518', 'and dark ink on light paper');
  assert.equal(palette.line, 'rgb(0 0 0 / 0.10)', 'with a dark hairline, not a white one');
});

test('a token that names itself is believed over inference', () => {
  const palette = pickPalette({ colors: ['#ffffff', '#ff0080'], tokens: { '--surface': '#0d0d0f', '--radius': '20px' } });
  assert.equal(palette.surface, '#0d0d0f');
  assert.equal(palette.radius, '20px');
});

test('a saturated theme colour is branding, not a ground', () => {
  const palette = pickPalette({ colors: ['#faf9f7', '#2563eb'], themeColor: '#2563eb', tokens: {} });
  assert.equal(palette.surface, '#faf9f7', 'the blue is the accent, so paper is the surface');
  assert.equal(palette.accent, '#2563eb');
});

test('a page with no accent has nothing worth borrowing', () => {
  assert.equal(pickPalette({ colors: ['#eeeeee', '#333333'], tokens: {} }), null);
  assert.equal(pickPalette({}), null);
  assert.equal(pickPalette({ colors: ['not-a-colour', 'rgb(nope)'], tokens: {} }), null);
});

test('a font list splits into a display face and a text face', () => {
  assert.deepEqual(pickFonts(['"Space Grotesk", sans-serif', 'Inter', 'sans-serif']), {
    display: 'Space Grotesk', body: 'Inter',
  });
  // One family is a pairing, not a gap: Inter at 700 is a display face.
  assert.deepEqual(pickFonts(['Inter']), { display: 'Inter', body: 'Inter' });
  assert.deepEqual(pickFonts(['system-ui', 'inherit', 'serif']), { display: null, body: null });
  assert.deepEqual(pickFonts(['Fraunces', 'Inter', 'Fraunces']), { display: 'Fraunces', body: 'Inter' });
});

test('the foundation carries a stylesheet link for both faces', () => {
  const out = buildDesignFoundation({ designs: [DARK], text: 'coffee roastery' });
  assert.match(out, /fonts\.googleapis\.com\/css2\?family=Space\+Grotesk:wght@500;700&family=Inter:wght@400;500&display=swap/);
  assert.match(out, /preconnect.*fonts\.gstatic\.com/s);
  assert.match(out, /--display: "Space Grotesk"/);
  assert.match(out, /--body: "Inter"/);
});

test('a single family is requested once, with every weight it will need', () => {
  const out = buildDesignFoundation({ designs: [{ colors: ['#111318', '#ff5a1f'], fonts: ['Inter'] }], text: 'x' });
  assert.match(out, /css2\?family=Inter:wght@400;500;600;700&display=swap/);
  assert.doesNotMatch(out, /family=Inter:wght@400;500&/, 'not the same family twice');
  assert.match(out, /--display: "Inter"/);
  assert.match(out, /--body: "Inter"/);
});

test('the reveal never hides a section that will not be revealed', () => {
  // The hidden state used to be unconditional, so a page whose script never
  // ran — or a reader who asked for reduced motion — saw blank sections.
  const out = buildDesignFoundation({ designs: [], text: 'x' });
  assert.match(out, /\.reveal\{opacity:1\}/, 'visible by default');
  assert.match(out, /@media \(prefers-reduced-motion:no-preference\)\{[^}]*\.reveal\.reveal-on\{opacity:0/s, 'hidden only when motion is welcome');
  assert.match(out, /el\.classList\.add\("reveal-on"\)/, 'and only once the script is running');
});

test('the foundation is real CSS, with the scale and rhythm from the playbook', () => {
  const out = buildDesignFoundation({ designs: [DARK], text: 'x' });
  for (const rule of [
    '--surface: #0b0b0f', '--accent: #ff5a1f',
    'clamp(2.75rem,7vw,6.5rem)', 'clamp(4.5rem,10vw,9rem)', '62ch',
    'cubic-bezier(.2,.8,.2,1)', ':focus-visible', 'prefers-reduced-motion',
  ]) {
    assert.ok(out.includes(rule), `carries ${rule}`);
  }
  assert.match(out, /IntersectionObserver/, 'and the reveal actually runs');
});

test('it says it is a starting point, not a template to reproduce', () => {
  const out = buildDesignFoundation({ designs: [DARK], text: 'x' });
  assert.match(out, /Do not reproduce these rules unchanged/);
  assert.match(out, /read from the pages above/);
});

test('a token value cannot smuggle markup into the CSS', () => {
  // Values come from pages we do not control. The foundation is text in a
  // prompt rather than rendered HTML, but a token that closes the block and
  // opens a script is still refused rather than passed through.
  const out = buildDesignFoundation({
    designs: [{ colors: ['#111318', '#ff5a1f'], tokens: { '--radius': '16px}</style><script>alert(1)</script>' } }],
    text: 'x',
  });
  assert.ok(!out.includes('alert(1)'), 'the payload is gone');
  assert.match(out, /--radius: 16px;/, 'and the default stands in for it');
});

test('without references two different briefs do not land on the same palette', () => {
  const seen = new Set();
  for (const brief of ['coffee roastery', 'dev tooling', 'wedding photographer', 'crypto dashboard', 'yoga studio']) {
    const out = buildDesignFoundation({ designs: [], text: brief });
    assert.match(out, /starting palette rather than a borrowed one/);
    seen.add(out.match(/--accent: (#[0-9a-f]{6})/)[1]);
  }
  assert.ok(seen.size >= 3, `expected variety, got ${[...seen].join(' ')}`);
});

test('a borrowed palette beats a default one', () => {
  const out = buildDesignFoundation({ designs: [DARK], text: 'coffee roastery' });
  assert.match(out, /--accent: #ff5a1f/);
  assert.doesNotMatch(out, /starting palette rather than a borrowed one/);
});

test('parseColor reads the shapes a page actually uses', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor('#0b0b0f'), { r: 11, g: 11, b: 15 });
  assert.deepEqual(parseColor('rgb(17, 19, 24)'), { r: 17, g: 19, b: 24 });
  assert.deepEqual(parseColor('rgba(17 19 24 / 0.5)'), { r: 17, g: 19, b: 24 });
  for (const junk of ['', 'not-a-colour', 'rgb(nope)', '#12', 'var(--x)', null, undefined]) {
    assert.equal(parseColor(junk), null, `${junk} is not a colour`);
  }
});
