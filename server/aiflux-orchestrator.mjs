// AIFLUX Flux Orchestrator.
//
// Flux is the project manager. For non-trivial user requests it coordinates
// the other family members in sequence before drafting the final answer:
//
//   1. Ziker (Planner)   -> break the work into concrete steps.
//   2. Toki  (Live Web)  -> run web search for current facts if needed.
//   3. Hiku  (Coder)     -> produce code / edits / executable artifacts.
//   4. Siku  (Reviewer)  -> review Hiku's output for bugs, security issues,
//                           and alignment with the plan; produce a revised
//                           answer if it finds problems.
//
// Each sub-agent call is a short, bounded, non-streaming completion that
// reuses the same multi-route failover machinery as the main answer stream.
// The user sees live phase events (planning / researching / coding /
// reviewing) so they know work is happening behind the scenes.
//
// Trivial requests (greetings, one-line questions, clarifications) skip the
// orchestration pipeline entirely and go straight to the answer model.

import { buildRequest, extractChunk, readSSE, friendlyUpstreamError, RequestError } from './providers.mjs';
import { searchWeb } from './search.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';
import { memberInfo, resolveAIFluxRoutes, KEYLESS_PROVIDERS } from './aiflux-family.mjs';

// Max per-sub-agent wall time. Kept short so the whole orchestration stays
// snappy even when one route flakes.
const PHASE_TIMEOUT_MS = 25_000;
const KEYLESS_PHASE_TIMEOUT_MS = 12_000;

// Upper bound on sub-agent reply length — we don't need novels in internal
// handoffs, just concrete actionable output.
const PHASE_MAX_CHARS = 6_000;

// Phases the orchestrator can run, in order. The set of phases actually used
// depends on classifyRequest() — trivial/greeting/code-review-only requests
// skip phases they don't need.
export const PHASES = Object.freeze({
  plan:   { member: 'ziker', event: 'planning',  label: 'Planning with Ziker',     description: 'Breaking down the request' },
  search: { member: 'toki',  event: 'research',  label: 'Researching with Toki',   description: 'Searching the live web for current info' },
  code:   { member: 'hiku',  event: 'coding',    label: 'Coding with Hiku',        description: 'Writing code and Canvas edits' },
  review: { member: 'siku',  event: 'reviewing', label: 'Reviewing with Siku',     description: 'Reviewing the work for bugs and quality' },
});

const BUILD_KEYWORDS = /\b(build|create|make|implement|write|code|develop|design|add|generate|fix|debug|refactor|setup|scaffold|deploy|integrate|component|app|website|landing page|react|vue|svelte|next\.?js|node|express|api|server|frontend|backend|ui|css|html|function|script|bot|cli|database|sql|python|typescript|javascript)\b/i;

const WEB_KEYWORDS = /\b(latest|recent|current|today|this week|this month|202[5-9]|release|version|price|documentation|docs|api key|how (do|can) i|tutorial|download|news|weather|stock|live|status|deprecated|new feature|changelog)\b/i;

export function classifyRequest(question) {
  const q = String(question || '').trim();
  if (!q) return { plan: false, search: false, code: false, review: false };
  const looksLikeBuild = BUILD_KEYWORDS.test(q);
  const looksLikeWeb = WEB_KEYWORDS.test(q);
  const isLong = q.length > 60;
  // Very short messages (greetings, thanks, one-liners) go straight to the
  // final answer — no orchestration needed.
  if (q.length < 20 && !looksLikeBuild && !looksLikeWeb) {
    return { plan: false, search: false, code: false, review: false };
  }
  return {
    plan:   looksLikeBuild || isLong,
    search: looksLikeWeb || (looksLikeBuild && /api|fetch|library|package|version|install|npm|docs/.test(q)),
    code:   looksLikeBuild,
    review: looksLikeBuild,
  };
}

/**
 * Consume an SSE stream fully and return the concatenated text, or throw.
 */
async function drainSSE(stream, format, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('phase-timeout')), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  let text = '';
  let model = '';
  try {
    for await (const data of readSSE(stream)) {
      if (controller.signal.aborted) throw new RequestError(504, 'Sub-agent timed out.');
      const part = extractChunk(format, data);
      if (part.error) throw new RequestError(502, String(part.error).slice(0, 240));
      if (part.model && !model) model = part.model;
      if (part.text) text += part.text;
      if (part.done) break;
      if (text.length > PHASE_MAX_CHARS) break;
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  return { text: text.trim(), model };
}

/**
 * Run a single-turn non-streaming completion against the best available route
 * for the given AIFLUX member, transparently failing over on errors. Returns
 * the produced text or null if every route failed (the caller treats null as
 * "skip this phase — not fatal").
 */
async function callMember(memberId, messages, { userKeys, envKeys, ollamaConfigured, signal }) {
  const routes = resolveAIFluxRoutes(memberId, userKeys, envKeys, ollamaConfigured);
  const info = memberInfo(memberId);
  let lastError = null;
  for (const route of routes) {
    if (signal?.aborted) return null;
    const timeoutMs = KEYLESS_PROVIDERS.has(route.provider) ? KEYLESS_PHASE_TIMEOUT_MS : PHASE_TIMEOUT_MS;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(new Error('phase-timeout')), timeoutMs);
    try {
      const systemPrompt = buildAssistantPrompt({ provider: route.provider, model: route.model, searchMode: 'off' })
        + `\n\nYou are acting internally as AIFLUX ${info.name} (${info.role}). ${info.systemAddendum} Produce concise, concrete output — no chatty preamble, no apologies, just the result.`;
      const req = buildRequest({
        provider: route.provider, model: route.model,
        messages, searchMode: 'off', systemPrompt,
      }, route.key, ollamaConfigured);
      const upstream = await fetch(req.url, { ...req.options, signal: ctrl.signal });
      if (!upstream.ok) {
        const raw = await upstream.text().catch(() => '');
        throw new RequestError(upstream.status >= 500 ? 502 : upstream.status, friendlyUpstreamError(upstream.status, raw, route.key));
      }
      if (!upstream.body) throw new RequestError(502, 'empty');
      const { text } = await drainSSE(upstream.body, req.format, timeoutMs, ctrl.signal);
      if (!text || text.length < 2) throw new RequestError(502, 'empty');
      return { member: memberId, provider: route.provider, model: route.model, text: text.slice(0, PHASE_MAX_CHARS) };
    } catch (err) {
      lastError = err;
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ctrl.abort(); } catch { /* noop */ }
    }
  }
  // All routes failed — non-fatal. Orchestration can still produce a final
  // answer from whatever partial context it has.
  return null;
}

/**
 * Run the orchestrator pipeline for a user request. Emits phase events on
 * `sendEvent` and returns { plan, research, code, review } shaped results to
 * be injected into the final answer system prompt.
 *
 * @param {object} args
 * @param {string} question - the cleaned user question (no canvas snapshot).
 * @param {object} userKeys / envKeys / ollamaConfigured - routing context.
 * @param {function} sendEvent - SSE event emitter.
 * @param {AbortSignal} signal
 * @param {{searchKey: string, envSearchKey: string}} searchCfg
 */
export async function runOrchestrator({ question, userKeys, envKeys, ollamaConfigured, sendEvent, signal, searchCfg }) {
  const phases = classifyRequest(question);
  const result = { plan: null, research: null, code: null, review: null };

  // Phase 1 — Ziker the planner.
  if (phases.plan && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'planning', label: PHASES.plan.label, description: PHASES.plan.description });
    const planResult = await callMember('ziker', [{
      role: 'user',
      content: `Break the following user request into 3–6 concrete, ordered build steps. Keep each step to one sentence, focused on files to create/change and implementation order. Do not write code yet.\n\nUser request:\n${question}`,
    }], { userKeys, envKeys, ollamaConfigured, signal });
    if (planResult) result.plan = planResult;
  }

  // Phase 2 — Toki live web research (uses actual web search, not just the
  // model, so sources stay grounded and current).
  if (phases.search && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'research', label: PHASES.search.label, description: PHASES.search.description });
    const query = await (async () => {
      // Ask Toki for a focused search query, with failover.
      const q = await callMember('toki', [{
        role: 'user',
        content: `Given this user request, produce ONE short web-search query (max 12 words) to find the latest, most relevant information. Reply with only the query, nothing else.\n\nUser request:\n${question}`,
      }], { userKeys, envKeys, ollamaConfigured, signal });
      return q?.text?.replace(/^["']|["']$/g, '').trim().slice(0, 180) || question.slice(0, 180);
    })();
    try {
      const sources = await searchWeb(query, searchCfg.searchKey || searchCfg.envSearchKey, { signal });
      if (sources?.length) result.research = { query, sources, member: 'toki' };
    } catch {
      // Search failure is non-fatal; fall through to code/review without it.
    }
  }

  // Phase 3 — Hiku the coder.
  if (phases.code && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'coding', label: PHASES.code.label, description: PHASES.code.description });
    const hikuPrompt = [
      `User request:\n${question}`,
      result.plan ? `\nPlan from Ziker:\n${result.plan.text}` : '',
      result.research?.sources?.length
        ? `\nLive web sources from Toki:\n${result.research.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.snippet}`).join('\n\n')}`
        : '',
      `\nWrite the implementation. Use the Canvas tools (<af-tool name="...">) to create/edit files directly. Produce complete, runnable code. Be concise after the tool calls.`,
    ].join('\n');
    const codeResult = await callMember('hiku', [{ role: 'user', content: hikuPrompt }], { userKeys, envKeys, ollamaConfigured, signal });
    if (codeResult) result.code = codeResult;
  }

  // Phase 4 — Siku the reviewer.
  if (phases.review && result.code && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'reviewing', label: PHASES.review.label, description: PHASES.review.description });
    const reviewResult = await callMember('siku', [{
      role: 'user',
      content: [
        `User request:\n${question}`,
        result.plan ? `\nPlan:\n${result.plan.text}` : '',
        `\nHiku's draft output (may include <af-tool> Canvas edit calls):\n${result.code.text}`,
        `\nReview this for bugs, security issues, missing error handling, and alignment with the request. If it is correct, reply with exactly "OK". If you find issues, produce a corrected version of any code or <af-tool> calls that need changes, plus a one-paragraph summary of what you fixed.`,
      ].join('\n'),
    }], { userKeys, envKeys, ollamaConfigured, signal });
    if (reviewResult && !/^ok[.!]?$/i.test(reviewResult.text.trim())) {
      result.review = reviewResult;
    }
  }

  return result;
}

/**
 * Build the additional system-prompt block that summarizes orchestrator
 * findings for the final (Flux) answer turn.
 */
export function orchestratorContextBlock(ctx) {
  if (!ctx || (!ctx.plan && !ctx.research && !ctx.code && !ctx.review)) return '';
  const parts = ['\n\n<orchestrator_context>'];
  parts.push('The following internal work was completed by the AIFLUX family before you answered. Build directly on top of it — do NOT repeat planning steps the user can already see.');
  if (ctx.plan) parts.push(`\n[Ziker's plan]\n${ctx.plan.text}`);
  if (ctx.research?.sources?.length) {
    parts.push(`\n[Toki's live web research — query: ${ctx.research.query}]`);
    parts.push(ctx.research.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.snippet}`).join('\n\n'));
  }
  if (ctx.code) parts.push(`\n[Hiku's code draft]\n${ctx.code.text}`);
  if (ctx.review) parts.push(`\n[Siku's review / corrections]\n${ctx.review.text}`);
  parts.push('</orchestrator_context>');
  parts.push('If Hiku or Siku already produced <af-tool> Canvas tool calls, you MUST include those calls verbatim in your final answer so the Canvas applies them. Do NOT re-explain the plan step-by-step unless the user asks. Present the finished result concisely.');
  return parts.join('\n');
}
