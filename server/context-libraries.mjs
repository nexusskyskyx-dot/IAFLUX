const LIBRARIES = Object.freeze([
  Object.freeze({
    id: 'web-design',
    name: 'Web design inspiration',
    matches: /\b(?:web\s*design|design|visual|inspiration|website|webpage|landing\s?page|layout|styling|css|responsive|portfolio|brand|theme)\b/i,
    context: `Design for the user's goal and content, not a trend checklist: establish hierarchy, readable type, deliberate spacing, a coherent color system, responsive behavior, and a clear primary action. Use motion and decoration sparingly and honor reduced-motion preferences. Inspiration catalogs include Awwwards (awwwards.com), Godly (godly.website), Mobbin (mobbin.com), Lapa Ninja (lapa.ninja), and Dribbble (dribbble.com); use them to study patterns, not copy another creator's work. This is a static starting list, not a verified ranking or statement about today's trends, access, or pricing.`,
  }),
  Object.freeze({
    id: 'frontend-libraries',
    name: 'Frontend and component libraries',
    matches: /\b(?:frontend|front-end|react|vue|svelte|angular|next\.?(?:js)?|vite|tailwind|shadcn|radix|react\s?aria|mui|material\s?ui|chakra|bootstrap|lucide|motion|component\s?library|design\s?system|ui\s?kit|npm|package|library|libraries|framework|frameworks)\b/i,
    context: `Useful options to evaluate—not a popularity ranking—include React and its official docs (react.dev); Tailwind CSS (tailwindcss.com/docs); shadcn/ui (ui.shadcn.com/docs), a customizable copy-into-your-project component collection; Radix Primitives (radix-ui.com/primitives) and React Aria (react-spectrum.adobe.com/react-aria) for accessible primitives; Material UI (mui.com) or Bootstrap (getbootstrap.com) for fuller component systems; Motion (motion.dev) for animation; and Lucide (lucide.dev) for icons. Prefer the repository's existing stack. Compare the exact need, accessibility, theming, bundle cost, license, maintenance, API stability, and integration effort before recommending or adding a dependency. Verify current versions and project-specific setup in official docs when live search is available.`,
  }),
  Object.freeze({
    id: 'backend-libraries',
    name: 'Backend, API, and data libraries',
    matches: /\b(?:backend|back-end|api|server|database|sql|orm|fastapi|django|flask|express|fastify|hono|prisma|drizzle|sqlalchemy|postgres(?:ql)?|sqlite)\b/i,
    context: `Backend choices to evaluate—not a current popularity ranking—include Express (expressjs.com), Fastify (fastify.dev), or Hono (hono.dev) for JavaScript/TypeScript services; FastAPI (fastapi.tiangolo.com), Django (docs.djangoproject.com), or Flask (flask.palletsprojects.com) for Python; and Prisma (prisma.io/docs), Drizzle (orm.drizzle.team), or SQLAlchemy (docs.sqlalchemy.org) for data access. For databases, consult the official PostgreSQL (postgresql.org/docs) or SQLite (sqlite.org/docs) documentation. Fit the runtime, deployment target, existing stack, migrations, security, licensing, and maintenance; verify current compatibility in official docs rather than assuming one framework is best.`,
  }),
  Object.freeze({
    id: 'testing',
    name: 'Testing and verification',
    matches: /\b(?:test|testing|tests|unit\s?test|integration\s?test|regression|e2e|end[ -]?to[ -]?end|playwright|vitest|jest|testing\s?library|coverage|verify|verification)\b/i,
    context: `Match tests to the risk: focused unit tests for rules, integration tests for boundaries, and browser/end-to-end tests for critical user journeys. Keep tests deterministic and assert both expected behavior and important failure cases. This AIFLUX repository currently uses Node's built-in test runner via npm test; follow the existing package.json instead of adding a test dependency without a reason. Vitest, Playwright, Jest, and Testing Library are options for projects whose needs justify them; check their official docs and compatibility.`,
  }),
  Object.freeze({
    id: 'security',
    name: 'Application security and privacy',
    matches: /\b(?:security|secure|privacy|authentication|authorization|oauth|permission|secret|token|injection|xss|csrf|ssrf|encrypt|credential|vulnerability|threat\s?model)\b/i,
    context: `Use least privilege and secure defaults. Validate inputs on the server, encode output for its context, protect secrets from prompts/logs/client storage, limit access and data retention, and consider injection, cross-site scripting/request forgery, server-side request forgery, dependency/supply-chain risks, and authorization boundaries. Prefer official security guidance for each stack; do not claim a system is secure or compliant without testing and review.`,
  }),
  Object.freeze({
    id: 'coding-practice',
    name: 'Coding libraries and engineering practice',
    matches: /\b(?:code|coding|program|programming|debug|bug|software|developer|implementation|function|algorithm|api|backend|server|database|testing|test|typescript|javascript|python|java|rust|golang|node(?:\.js)?|express|npm|package|dependency|library|libraries|framework|frameworks)\b/i,
    context: `Start by identifying the repository's actual language, framework, package manager, conventions, and existing dependencies. Prefer a small change using the installed stack over introducing a package by default. For library choices, check official documentation, supported runtime/framework versions, license, maintenance/release activity, security posture, and bundle/runtime impact. Explain assumptions; give complete, composable code; include error handling and focused tests or verification steps. Never say code was run or a test passed unless the app actually reports that it ran.`,
  }),
  Object.freeze({
    id: 'reasoning',
    name: 'Reasoning and problem solving',
    matches: /\b(?:think|thinking|reason|reasoning|analy[sz](?:e|is|ing)|compare|comparison|trade[ -]?offs?|decision|decide|plan|planning|strategy|why|explain|evaluate|approach|problem.?solve|logic|pros\s?and\s?cons)\b/i,
    context: `For complex questions, decompose the goal, constraints, and unknowns; make assumptions explicit; compare viable options against relevant criteria; check for counterexamples or failure modes; and verify conclusions against evidence or tests where possible. Share the concise rationale, key evidence, uncertainty, and actionable conclusion—not private hidden chain-of-thought or a fabricated step-by-step inner monologue.`,
  }),
  Object.freeze({
    id: 'conversation-writing',
    name: 'Conversation and writing',
    matches: /\b(?:conversation|talk|communicat|write|writing|email|reply|response|dialogue|story|tone|wording|message|presentation|summari[sz]|teach|tutor|explain|brainstorm|interview|feedback)\w*\b/i,
    context: `Answer the actual request and preserve the user's intent, preferred tone, and audience. Listen for explicit constraints, distinguish facts from suggestions, and be warm without being patronizing or verbose. Ask a question only when a missing detail materially changes the result; otherwise make a reasonable assumption and label it. For drafts, give usable language the user can adapt.`,
  }),
  Object.freeze({
    id: 'accessibility',
    name: 'Accessibility and inclusive design',
    matches: /\b(?:accessib(?:ility|le)|inclusive|wcag|a11y|screen\s?reader|keyboard|focus|contrast|reduced\s?motion|semantic\s?html|aria)\b/i,
    context: `Treat accessibility as a core requirement: use semantic HTML and correctly labelled controls; ensure keyboard operation and visible focus; maintain readable contrast and text sizing; provide useful names, error messages, and status announcements; avoid color-only meaning; and respect reduced motion. Use WCAG guidance and the framework's official accessibility documentation for concrete requirements. Do not claim formal conformance without an audit.`,
  }),
  Object.freeze({
    id: 'product-research',
    name: 'Library and product research',
    matches: /\b(?:trend|trending|popular|current|latest|best|top|newest|recommend(?:ation)?|compare|alternatives?|research|market|ecosystem|state\s?of\s?the\s?art)\b/i,
    context: `For recommendations, first establish the use case and constraints, then compare a short list using fit, official documentation, compatibility, accessibility, maintenance/release activity, community evidence, license, security, and total cost. Treat stars, rankings, and showcase pages as incomplete signals. A static library list is not proof of what is trending now: use live search and cite the returned sources for current releases, rankings, adoption, availability, or pricing; if no search was performed or evidence is inconclusive, say so.`,
  }),
]);

export const CONTEXT_LIBRARY_NAMES = Object.freeze(LIBRARIES.map(({ name }) => name));

const CONTEXT_BASE = `Context+ is a small, curated prompt library—not an installed package, executable tool, live documentation mirror, or claim that a resource is current. Apply only notes relevant to the user's request. Prefer the user's existing project choices. Think through goals, constraints, alternatives, and uncertainty; share a concise rationale and conclusion, never private hidden chain-of-thought. Communicate clearly for the user's audience, preserve their intent, and ask only questions that materially unblock the work. For current versions, trends, popularity, availability, or pricing, rely on live web-search results only when the server says it searched; otherwise state that current details are unverified.`;

function searchableText(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/<untrusted_web_search_data>[\s\S]*?<\/untrusted_web_search_data>/gi, ' ')
    .replace(/\n\nAttached file:[\s\S]*$/i, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .slice(0, 2400);
}

function asksForLibraryCatalog(message) {
  return /(?:\bcontext\s?\+|\bcontext\s+plus\b|\bcontext\s+librar(?:y|ies)\b|\bknowledge\s+librar(?:y|ies)\b|\breference\s+(?:packs?|librar(?:y|ies))\b|\ball\s+(?:the\s+)?(?:available\s+)?librar(?:y|ies)\b)/i.test(message);
}

export function selectContextLibraries(message = '') {
  const searchable = searchableText(message);
  if (!searchable) return [];
  if (asksForLibraryCatalog(searchable)) return [...LIBRARIES];
  const selectedIds = new Set(LIBRARIES.filter(({ matches }) => matches.test(searchable)).map(({ id }) => id));
  if (selectedIds.has('web-design') || selectedIds.has('frontend-libraries')) selectedIds.add('accessibility');
  return LIBRARIES.filter(({ id }) => selectedIds.has(id));
}

export function buildContextLibraryPrompt(message = '') {
  const selected = selectContextLibraries(message);
  const selectedNotes = selected.map(({ name, context }) => `### ${name}\n${context}`);
  return [
    'AIFLUX Context+ reference library:',
    CONTEXT_BASE,
    ...(selectedNotes.length ? ['Relevant context packs selected for this message:', ...selectedNotes] : []),
  ].join('\n\n');
}
