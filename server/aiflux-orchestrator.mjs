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

// Per-sub-agent wall time budgets, tuned by effort. Fast mode tightens them
// aggressively; Power mode gives deep reasoning models (DeepSeek R1, Nemotron
// Ultra) more breathing room. Multi-route failover jumps to the next model
// as soon as this fires.
function phaseBudget(effort, keyless) {
  if (effort === 'fast') return keyless ? 5_000 : 7_000;
  if (effort === 'power') return keyless ? 12_000 : 20_000;
  return keyless ? 8_000 : 12_000;
}

// Upper bound on sub-agent reply length. Internal handoffs should be tight
// in fast mode; power mode lets plans/reviews be more thorough.
function phaseCharLimit(effort) {
  if (effort === 'fast') return 2_000;
  if (effort === 'power') return 8_000;
  return 4_000;
}

// How many parallel web-search queries Toki fires in research phase.
function researchBudget(effort) {
  if (effort === 'fast') return 1;
  if (effort === 'power') return 3;
  return 2;
}

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
async function drainSSE(stream, format, timeoutMs, signal, charLimit) {
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
      if (text.length > charLimit) break;
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
async function callMember(memberId, messages, { userKeys, envKeys, ollamaConfigured, signal, effort = 'auto' }) {
  const routes = resolveAIFluxRoutes(memberId, userKeys, envKeys, ollamaConfigured);
  const info = memberInfo(memberId);
  const charLimit = phaseCharLimit(effort);
  for (const route of routes) {
    if (signal?.aborted) return null;
    const keyless = KEYLESS_PROVIDERS.has(route.provider);
    const timeoutMs = phaseBudget(effort, keyless);
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
      const { text } = await drainSSE(upstream.body, req.format, timeoutMs, ctrl.signal, charLimit);
      if (!text || text.length < 2) throw new RequestError(502, 'empty');
      return { member: memberId, provider: route.provider, model: route.model, text: text.slice(0, charLimit) };
    } catch (err) {
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ctrl.abort(); } catch { /* noop */ }
    }
  }
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
export async function runOrchestrator({ question, userKeys, envKeys, ollamaConfigured, sendEvent, signal, searchCfg, effort = 'auto' }) {
  const phases = classifyRequest(question);
  // In fast mode, skip planning + research for anything that isn't a search-
  // flagged build request — direct-to-answer is fastest.
  const doPlan   = phases.plan   && effort !== 'fast';
  const doSearch = phases.search && effort !== 'fast';
  const doCode   = phases.code;
  const doReview = phases.review && effort !== 'fast';
  const result = { plan: null, research: null, code: null, review: null, finalMember: 'flux' };

  // PHASE 1 + 2 run in parallel: Ziker plans while Toki researches.
  const parallelTasks = [];

  if (doPlan && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'planning', label: PHASES.plan.label, description: PHASES.plan.description });
    parallelTasks.push(
      callMember('ziker', [{
        role: 'user',
        content: `Break this request into ${effort === 'power' ? '4-8' : '3-6'} ordered steps. One sentence per step, focused on files to create/change. No code.\n\nRequest:\n${question}`,
      }], { userKeys, envKeys, ollamaConfigured, signal, effort }).then((r) => { result.plan = r; })
    );
  }

  if (doSearch && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'research', label: PHASES.search.label, description: PHASES.search.description });
    parallelTasks.push((async () => {
      // Ask Toki for N diverse queries (broad, specific, version-sensitive),
      // then search them all in parallel and merge+dedupe sources.
      const n = researchBudget(effort);
      const qPrompt = n === 1
        ? `Produce ONE short web-search query (max 12 words) for this request. Reply with only the query.`
        : `Produce ${n} DIFFERENT short web-search queries (max 12 words each) for this request, one per line. Cover: (1) broad topic, (2) specific docs/version,${n >= 3 ? ' (3) examples/tutorials,' : ''} each query on its own line. No numbering, no bullets.`;
      const qRes = await callMember('toki', [
        { role: 'user', content: `${qPrompt}\n\nRequest:\n${question}` },
      ], { userKeys, envKeys, ollamaConfigured, signal, effort });
      const raw = (qRes?.text || question).trim();
      const queries = (n === 1 ? [raw] : raw.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean))
        .map((q) => q.replace(/^["']|["']$/g, '').trim().slice(0, 180))
        .filter((q, i, arr) => q.length > 3 && arr.indexOf(q) === i)
        .slice(0, n);
      if (queries.length === 0) queries.push(question.slice(0, 180));
      const searchKey = searchCfg.searchKey || searchCfg.envSearchKey;
      const allSources = [];
      const seen = new Set();
      // Run queries in parallel, cap each at 4 results to keep total bounded.
      const results = await Promise.all(queries.map((q) =>
        searchWeb(q, searchKey, { signal }).then((srcs) => ({ q, srcs })).catch(() => ({ q, srcs: [] }))
      ));
      for (const { q, srcs } of results) {
        for (const s of (srcs || []).slice(0, 4)) {
          if (!s?.url || seen.has(s.url)) continue;
          seen.add(s.url);
          allSources.push({ ...s, _query: q });
          if (allSources.length >= (effort === 'power' ? 8 : 5)) break;
        }
        if (allSources.length >= (effort === 'power' ? 8 : 5)) break;
      }
      if (allSources.length) {
        result.research = { query: queries[0], queries, sources: allSources, member: 'toki' };
      }
    })());
  }

  await Promise.all(parallelTasks);
  if (signal?.aborted) return result;

  // PHASE 3 — Hiku codes, using plan + research if available.
  if (doCode && !signal?.aborted) {
    sendEvent({ type: 'phase', phase: 'coding', label: PHASES.code.label, description: PHASES.code.description });
    const hikuPrompt = [
      `Request:\n${question}`,
      result.plan ? `\nPlan:\n${result.plan.text}` : '',
      result.research?.sources?.length
        ? `\nSources:\n${result.research.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.snippet}`).join('\n\n')}`
        : '',
      effort === 'power'
        ? `\nWrite a complete, production-quality implementation using <af-tool name="..."> Canvas tools to create/edit files directly. Cover error states, edge cases, and responsive styling for HTML/CSS. All files must be created as separate <af-tool> calls.`
        : `\nWrite the implementation. Use <af-tool name="..."> Canvas tools to create/edit files directly. Produce complete, runnable code.`,
    ].join('\n');
    const codeResult = await callMember('hiku', [{ role: 'user', content: hikuPrompt }], { userKeys, envKeys, ollamaConfigured, signal, effort });
    if (codeResult) result.code = codeResult;
  }

  // PHASE 4 — Siku reviews Hiku's draft (fast mode skips this; power mode is
  // more thorough, asks for security+performance review, and runs an extra
  // Hiku ↔ Siku repair iteration if issues are found (build-until-done).
  if (doReview && result.code && !signal?.aborted) {
    const repairRounds = effort === 'power' ? 2 : 1;
    let currentCode = result.code.text;
    let lastReview = null;
    for (let round = 0; round < repairRounds; round++) {
      if (signal?.aborted) break;
      sendEvent({
        type: 'phase',
        phase: 'reviewing',
        label: PHASES.review.label,
        description: round === 0 ? PHASES.review.description : `Reviewing revision ${round}…`,
      });
      const reviewPrompt = effort === 'power'
        ? `Review for bugs, security issues, missing error handling, accessibility, responsive layout, and performance. If correct reply exactly "OK". Otherwise produce corrected <af-tool> calls plus a brief fix summary noting each issue category.`
        : `Review for bugs, security issues, missing error handling. If correct reply exactly "OK". Otherwise produce corrected <af-tool> calls plus a short fix summary.`;
      const reviewInput = [
        `Request:\n${question}`,
        result.plan ? `\nPlan:\n${result.plan.text}` : '',
        `\nCurrent code (${round === 0 ? 'initial draft' : `revision ${round}`}):\n${currentCode}`,
        ...(lastReview ? [`\nPrevious review issues (must all be fixed):\n${lastReview}`] : []),
        `\n${reviewPrompt}`,
      ].join('\n');
      const reviewResult = await callMember('siku', [{ role: 'user', content: reviewInput }], { userKeys, envKeys, ollamaConfigured, signal, effort });
      if (!reviewResult) break;
      const reviewText = reviewResult.text.trim();
      if (/^ok[.!]?$/i.test(reviewText)) { lastReview = null; break; }
      lastReview = reviewText;
      // Power mode: let Hiku revise based on the review.
      if (round < repairRounds - 1 && effort === 'power') {
        sendEvent({ type: 'phase', phase: 'coding', label: 'Revising', description: `Hiku addresses review feedback (revision ${round + 1})…` });
        const revisePrompt = [
          `Request:\n${question}`,
          result.plan ? `\nPlan:\n${result.plan.text}` : '',
          `\nCurrent code:\n${currentCode}`,
          `\nSiku's review (fix every issue):\n${reviewText}`,
          `\nProduce the corrected implementation with complete <af-tool> calls. Do NOT apologize; just output the fixed code.`,
        ].join('\n');
        const revised = await callMember('hiku', [{ role: 'user', content: revisePrompt }], { userKeys, envKeys, ollamaConfigured, signal, effort });
        if (revised && revised.text.trim().length > 50) currentCode = revised.text;
        else break;
      }
    }
    if (lastReview) {
      result.review = { member: 'siku', text: lastReview, provider: 'aiflux', model: 'siku' };
    }
    // Keep the final (possibly revised) code as Hiku's answer.
    result.code = { ...result.code, text: currentCode };
  }

  // Decide which family member should stream the final answer to the user.
  // * Coding tasks (code or review produced) → Hiku (coder voice).
  // * Pure reasoning questions (no code, plan only) → Siku.
  // * Research-only (no code) → Toki.
  // * Otherwise → Flux (general manager voice).
  if (result.code || result.review) result.finalMember = 'hiku';
  else if (result.plan && !result.research) result.finalMember = 'siku';
  else if (result.research && !result.code) result.finalMember = 'toki';
  else result.finalMember = 'flux';

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
