/**
 * Web-design knowledge for the model.
 *
 * A model asked to "make a website" has seen a great many websites and has an
 * opinion about none of them, so it produces the average of its training data:
 * centred hero, purple gradient, three identical cards. This module is the
 * correction — the vocabulary of what designers actually build, and a short
 * list of the defaults that give machine-generated pages away.
 *
 * The vocabulary is not invented here. It is the taxonomy the curated galleries
 * publish and organise their work by (see DESIGN_REFERENCES), which is also the
 * vocabulary a designer uses when describing what they want.
 */

/** The galleries the user works from, and how each is organised. */
export const DESIGN_REFERENCES = Object.freeze([
  {
    name: 'Landbook',
    url: 'https://land-book.com/',
    note: 'Curated gallery, human-reviewed, updated daily. Publishes an llms.txt index and organises work by page type and by individual section.',
    sections: 'https://land-book.com/sections',
    byType: {
      'landing page': 'https://land-book.com/design/landing-page',
      portfolio: 'https://land-book.com/design/portfolio',
      ecommerce: 'https://land-book.com/design/ecommerce',
      blog: 'https://land-book.com/design/blog',
      'about us': 'https://land-book.com/design/about-us-page',
      career: 'https://land-book.com/design/career-page',
      'sign up': 'https://land-book.com/design/sign-up-page',
      pricing: 'https://land-book.com/design/pricing-page',
      'case study': 'https://land-book.com/design/case-study',
      'product page': 'https://land-book.com/design/product-page',
    },
    also: {
      motion: 'https://land-book.com/motion',
      'OG images': 'https://land-book.com/og-images',
      headlines: 'https://land-book.com/headlines',
    },
  },
  {
    name: 'Godly',
    url: 'https://godly.design/',
    note: 'Curated gallery of web, app, UI and visual design work. Good for current visual trends and logo/OG treatments.',
  },
  {
    name: 'Awwwards',
    url: 'https://www.awwwards.com/',
    note: 'Awarded sites. Judged on design, creativity, content and usability — so it rewards pages that work, not just pages that look unusual.',
  },
]);

/**
 * The section vocabulary, taken from how Landbook slices real pages. Naming
 * these gives the model a plan to compose from instead of one undifferentiated
 * slab of markup.
 */
const SECTION_VOCABULARY = 'hero, value proposition, features, how it works, testimonial, brand logos, stats, pricing, resources, FAQ, call to action, footer, about us, case study';

export const DESIGN_PLAYBOOK = `BUILDING A WEB PAGE — apply this whenever the work is a site, page, or interface.

Decide the archetype first. Most requests are one of: landing page, portfolio,
ecommerce, blog, about us, career, sign-up, pricing, case study, product listing,
or product page. Each has a different job; a pricing page that reads like a
portfolio has failed. Say which one you are building and compose for it.

Compose in sections, not in one slab. Real pages are built from: ${SECTION_VOCABULARY}.
Pick the ones the archetype needs, order them so each earns the next, and give
every section a distinct job. Omit the ones that add nothing.

Typography. One display face, one text face — two is already a system. Size with
a fluid clamp() so it holds up from phone to desktop. Tighten tracking on large
display text (about -0.02em to -0.04em) and loosen it on small uppercase labels.
Keep body measure near 60–75 characters. Weight, size and space carry hierarchy;
colour should not have to.

Space. Work on a 4px or 8px scale and let sections breathe — generous vertical
padding is what separates a designed page from a dense one. Use one spacing
rhythm throughout rather than per-section guesses.

Colour. One neutral ramp plus one accent is enough. Avoid pure #000 and pure
#fff; near-black and off-white read as designed. Check text against its
background for at least 4.5:1 (3:1 for large display text).

Motion. 150–400ms, ease-out, and only on transform and opacity. Animate in
response to something — scroll, hover, state change — never on a loop for
decoration. Wrap every animation in @media (prefers-reduced-motion: no-preference)
and give reduced-motion users the end state immediately.

Layout. Reach for grid and for asymmetry. The default three-equal-column card
row is the single clearest signal that nobody designed the page.

Avoid these defaults — they are what makes a page look machine-generated:
- A purple-to-blue gradient hero, or any gradient used as the whole personality.
- Three identical feature cards, each with an icon, a bold title, and one line.
- Placeholder copy: "Lorem ipsum", "Your Company", "Feature One". Write the real
  words, even if the user will change them.
- Emoji standing in for icons. Use inline SVG.
- A "Trusted by" row of invented logos.
- Glassmorphism, neon glow, or drop shadows on everything.
- Centring every element until nothing leads the eye.
- A stock-photo hero.
- Interactive elements with no hover, focus, or disabled state.

Accessibility floor, not optional: visible focus rings, semantic landmarks
(header/nav/main/footer), one h1 per page and a sensible heading order, alt text
on meaningful images, real labels on inputs, and a keyboard path through
everything clickable.

The Canvas preview runs in a sandboxed frame with no network. Anything loaded
from a CDN — Google Fonts, a framework from a script tag, remote images — will
not arrive, and the page will look broken to the user even though the file is
correct. So: use a system font stack or an @font-face with the file on the
Canvas, write CSS and JavaScript as local files, and inline SVG rather than
loading an icon set. Build the page to work with nothing but its own files.`;

const DESIGN_SIGNALS = /\b(website|web\s?site|webpage|web\s?page|landing\s?page|homepage|hero\s?(section|banner)?|portfolio|web\s?design|design(?:ed|ing)?\s+(?:a|an|the|my|our)?\s*(?:site|page|website|landing|ui|interface|layout)|ui\b|ux\b|user\s?interface|interface|layout|responsive|mobile[-\s]?first|css|scss|tailwind|stylesheet|theme|dark\s?mode|typography|font[s]?|colour\s?scheme|color\s?scheme|palette|animation[s]?|transition[s]?|scroll|parallax|nav(?:bar|igation)?|footer|header|sidebar|modal|card[s]?|button[s]?|form\s?design|dashboard|component[s]?|design\s?system|mockup|wireframe|framer|webflow|figma|make\s+it\s+(?:look|pretty|beautiful|modern|nice|better)|restyle|redesign|style\s+this|html\b|jsx?\b|react\s+component|pricing|testimonial|faq|call\s+to\s+action|product\s?page|sign[-\s]?up|checkout|ecommerce|e[-\s]?commerce|about\s+us|case\s+study|gallery|template|brand\s?ing|logo|icon\s?set|style\s?guide)\b/i;

// Writing and editing markup is design work too, whatever the request says.
const DESIGN_EXTENSIONS = /\.(html?|css|scss|sass|jsx?|tsx?|vue|svelte)\b/i;

const NON_DESIGN = /\b(debug|error|exception|stack\s?trace|crash|bug|fix\s+the\s+(?:bug|error)|database|sql|api\s+key|environment\s+variable|deploy|docker|nginx|regex|algorithm|unit\s?test|typescript\s+type|refactor\s+this\s+function)\b/i;

/**
 * Whether this request is design work, so the playbook is only added when it
 * will be used. Padding every conversation with it costs tokens and dilutes it.
 */
export function isDesignRequest(text = '') {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (NON_DESIGN.test(value) && !DESIGN_EXTENSIONS.test(value)) return false;
  return DESIGN_SIGNALS.test(value) || DESIGN_EXTENSIONS.test(value);
}

/** How to reach the galleries, for a reply that names real references. */
export function describeReferences() {
  const lines = ['Design references the user works from. Open one with <url_fetch> when a real example would answer the question better than prose:'];
  for (const reference of DESIGN_REFERENCES) {
    lines.push(`- ${reference.name} — ${reference.url} — ${reference.note}`);
    if (reference.byType) {
      lines.push(`  Browse by page type: ${Object.entries(reference.byType).map(([type, url]) => `${type} ${url}`).join(' | ')}`);
    }
    if (reference.also) {
      lines.push(`  Also: ${Object.entries(reference.also).map(([label, url]) => `${label} ${url}`).join(' | ')}`);
    }
    if (reference.sections) lines.push(`  Section library (hero, pricing, FAQ, footer, and more): ${reference.sections}`);
  }
  return lines.join('\n');
}
