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

LOOK — use these values, adapted to the brief. Principles produce generic
pages; numbers produce designed ones. A model asked only to "use good
typography" will produce whatever it saw most often, which is the average of
every mediocre page it trained on.

- Surface: near-black #0B0B0F, or warm paper #FAF9F7. Never pure #000 or #fff.
- Colour: one accent, saturated, around 55-65% lightness, used on no more than
  two things per screen. One 10-step neutral ramp for everything else.
- Display: font-size clamp(2.75rem, 7vw, 6.5rem); font-weight 600-700;
  letter-spacing -0.03em; line-height 0.95-1.05.
- Section heading: clamp(1.75rem, 3.5vw, 2.75rem); letter-spacing -0.02em.
- Body: 1.0625rem; line-height 1.65; measure 62ch.
- Eyebrow/label: 0.6875rem; uppercase; letter-spacing 0.14em; muted colour.
- Section padding: clamp(4.5rem, 10vw, 9rem) block; inline clamp(1.25rem, 5vw, 4rem).
- Container: max-width 1200-1280px, centred; grid, not flex, for page structure.
- Radius: 16px on cards and panels; 999px on pills and buttons.
- One shadow, used consistently: 0 24px 60px -24px rgb(0 0 0 / 0.35).
- Edge light: a 1px border of rgb(255 255 255 / 0.07) on dark surfaces, or
  #00000012 on light ones. This is what stops flat panels looking unfinished.
- Grain: an inline SVG feTurbulence overlay at 3-5% opacity, fixed,
  pointer-events none. The cheapest way to stop a page reading as a template.

MOTION — motion is what separates a designed page from a static one, but it has
to be deliberate:
- Reveal on scroll: opacity 0 -> 1 with translateY(16px) -> 0, 520ms,
  cubic-bezier(.2,.8,.2,1), staggered 70ms between siblings. Use
  IntersectionObserver and unobserve after revealing.
- Hover: 160ms, transform and colour only. Never animate width, height, top,
  left, or margin.
- One signature moment per page: a marquee, a sticky section, a number that
  counts up, a cursor-following glow. Not all of them.
- Wrap every animation in @media (prefers-reduced-motion: no-preference) and
  give reduced-motion users the final state immediately.

AVOID — these are the defaults that make a page look generated. Each comes with
what to do instead, because knowing the rule is not the same as knowing the
alternative:
- Purple-to-blue gradient hero -> one flat near-black or paper field, plus a
  single radial glow in the accent at 12-18% opacity.
- Three identical feature cards in a row -> a bento grid of unequal cells, or
  a numbered list with hairline dividers, or one large panel beside two small.
- Centred everything -> an asymmetric split (7/5 or 8/4 grid): type on one
  side, visual on the other.
- Placeholder copy ("Lorem ipsum", "Your Company", "Feature One") -> write the
  real words, specific to whatever the user described.
- Emoji standing in for icons -> inline SVG, 1.5px stroke, 20-24px.
- A "Trusted by" row of invented logos -> leave it out, or name real ones.
- Glassmorphism, neon glow, a drop shadow on everything -> one shadow, one glow.
- Stock-photo or gradient-mesh hero -> CSS geometry, an inline SVG, or strong
  type on its own.
- Interactive elements with no hover, focus or disabled state -> style all three.
- A thin, timid page of 40 lines with a centred h1 and two buttons -> build the
  sections the archetype needs, usually five to seven, each with real copy.

BEFORE YOU WRITE — in one or two sentences, commit out loud to: the surface
colour, the one accent and where it appears, the display size and weight, and
the layout of each section you are about to build (which is asymmetric, and
where). Then write the files.

This is not ceremony. A model that starts typing immediately produces its
default, and its default is the average of every mediocre page it has seen.
Naming the choices first is what makes the result look designed rather than
generated; it is the whole difference between this working and not working.

Accessibility floor, not optional: text at least 4.5:1 against its background
(3:1 for large display text) — check it, do not assume it; visible focus rings;
semantic landmarks (header/nav/main/footer); one h1 per page and a sensible
heading order; alt text on meaningful images; real labels on inputs; and a
keyboard path through everything clickable.

WHAT THE PREVIEW ALLOWS — get this wrong and the page looks broken:
- Google Fonts DO load. Link the stylesheet from fonts.googleapis.com and the
  font files arrive from fonts.gstatic.com. Use them: a real display face is
  most of what separates a designed page from a default one, and falling back
  to a system font stack is the fastest way to look generic. Pick one display
  face and one text face, with only the weights you actually use.
- Remote scripts are blocked. Any framework, icon library or CDN script tag
  silently will not run. Write all CSS and JavaScript as local Canvas files.
- Remote images are blocked. Build visuals from CSS — gradients, geometry,
  grain — or inline SVG, or data: images. Not from a hosted image URL.
- JavaScript cannot reach the network at all: no fetch, no XHR, no WebSocket.
  Anything interactive has to work from data already on the page.`;

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
