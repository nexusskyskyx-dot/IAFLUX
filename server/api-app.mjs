import 'dotenv/config';
import express from 'express';
import catalog from '../src/data/models.json' with { type: 'json' };
import { isNonChatModelId } from '../src/lib/model-policy.mjs';
import { timingSafeEqual } from 'node:crypto';
import {
  RequestError, validateChat, buildRequest, friendlyUpstreamError,
  readSSE, readLines, extractChunk, getFreeOpenRouterModels,
} from './providers.mjs';
import { planWebSearch, searchWeb, shouldBypassSearch, withSearchContext } from './search.mjs';
import { listAIFluxModels, memberInfo, resolveAIFluxRoute, resolveAIFluxRoutes } from './aiflux-family.mjs';
import { buildAssistantPrompt } from './assistant-profile.mjs';
import { runOrchestrator, orchestratorContextBlock } from './aiflux-orchestrator.mjs';

const app = express();
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || '';
const accessCode = process.env.AIFLUX_ACCESS_CODE || '';
const envSearchKey = process.env.TAVILY_API_KEY?.trim() || '';
const envKeys = {
  openrouter: process.env.OPENROUTER_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
};

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use('/api', express.json({ limit: '500kb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/config', (_req, res) => {
  res.json({
    configured: Object.fromEntries(Object.entries(envKeys).map(([provider, key]) => [provider, Boolean(key)])),
    ollamaConfigured: Boolean(ollamaBaseUrl),
    searchConfigured: Boolean(envSearchKey),
    requiresAccessCode: Boolean(accessCode),
    aifluxAvailable: true, // Flux works out of the box via built-in keyless endpoints.
  });
});

// Seed cache with the curated static catalog so that /api/models always returns
// a useful list even before the live OpenRouter fetch succeeds (sandbox/offline).
let catalogCache = { at: 0, models: catalog };
app.get('/api/models', async (_req, res) => {
  let models = catalogCache.models;
  let catalogAvailable = true;
  if (Date.now() - catalogCache.at > 10 * 60 * 1000) {
    try {
      models = await getFreeOpenRouterModels();
      catalogCache = { at: Date.now(), models };
    } catch {
      catalogAvailable = false;
      models = catalogCache.models;
    }
  }
  // Always present the AIFLUX family models at the TOP of the catalog, before
  // provider-specific entries. These are routed server-side to the best
  // available free model for each persona.
  const aifluxModels = listAIFluxModels().map(({ _meta, ...rest }) => rest);
  let ollamaModels = [];
  if (ollamaBaseUrl) {
    try {
      const response = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = await response.json();
        ollamaModels = (data.models || []).filter((model) => typeof model.name === 'string' && !isNonChatModelId(model.name)).slice(0, 80).map((model) => ({
          id: model.name, provider: 'ollama', name: model.name,
          shortName: model.name, description: 'Runs privately on your Ollama server.',
          strength: 'Local & private', badge: 'LOCAL',
        }));
      }
    } catch { /* Ollama may not be running yet. */ }
  }
  res.json({ models: [...aifluxModels, ...models], ollamaModels, catalogAvailable });
});

const limits = new Map();
function rateLimit(req, res, next) {
  const address = req.ip || 'unknown';
  const now = Date.now();
  const previous = limits.get(address);
  const window = previous && now - previous.start < 10 * 60_000 ? previous : { start: now, count: 0 };
  window.count += 1;
  limits.set(address, window);
  if (limits.size > 1000) {
    for (const [key, value] of limits) if (now - value.start > 10 * 60_000) limits.delete(key);
  }
  if (window.count > 60) return res.status(429).json({ error: 'Too many requests from this workspace. Please try again in a few minutes.' });
  if (['auto', 'always'].includes(req.body?.searchMode)) {
    window.searches = (window.searches || 0) + 1;
    if (window.searches > 12) return res.status(429).json({ error: 'Too many web searches from this workspace. Try again in a few minutes.' });
  }
  next();
}

function correctAccessCode(candidate) {
  if (!accessCode) return true;
  if (typeof candidate !== 'string') return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(accessCode);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function startStream(res, model) {
  if (res.headersSent) return;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sendEvent(res, { type: 'start', model });
}

app.post('/api/chat', rateLimit, async (req, res) => {
  let timeout;
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (!correctAccessCode(req.get('x-aiflux-access-code'))) {
      throw new RequestError(403, 'Enter the workspace access code in Settings to continue.');
    }
    const searchHeader = req.get('x-aiflux-search-key')?.trim() || '';
    const keysHeader = req.get('x-aiflux-keys') || '';
    let userKeys = { openrouter: '', gemini: '', groq: '' };
    try {
      if (keysHeader) {
        const parsed = JSON.parse(decodeURIComponent(keysHeader));
        if (parsed && typeof parsed === 'object') {
          userKeys = {
            openrouter: typeof parsed.openrouter === 'string' ? parsed.openrouter.slice(0, 512) : '',
            gemini: typeof parsed.gemini === 'string' ? parsed.gemini.slice(0, 512) : '',
            groq: typeof parsed.groq === 'string' ? parsed.groq.slice(0, 512) : '',
          };
        }
      }
    } catch {
      throw new RequestError(400, 'Invalid API key header.');
    }
    if (searchHeader.length > 512) throw new RequestError(400, 'Invalid API key.');
    const suppliedSearchKey = searchHeader;

    // Build the full failover route list for AIFLUX family requests so we can
    // transparently try the next free provider when one misbehaves (empty
    // stream, 5xx, rate limit, SSE protocol errors like "invalid or omitted
    // terminal usage"). Non-AIFLUX requests get a single-element list.
    let aifluxRoutes = null;
    let memberAddendum = '';
    const bodyProvider = req.body?.provider;
    const bodyModel = req.body?.model;
    if (bodyProvider === 'aiflux') {
      aifluxRoutes = resolveAIFluxRoutes(bodyModel, userKeys, envKeys, Boolean(ollamaBaseUrl));
      memberAddendum = aifluxRoutes[0].memberAddendum;
    }

    // Validate using the first route, then swap routes in on retry.
    const input = validateChat(req.body, Boolean(ollamaBaseUrl), (memberId) => {
      const routes = aifluxRoutes || resolveAIFluxRoutes(memberId, userKeys, envKeys, Boolean(ollamaBaseUrl));
      return routes[0];
    });

    timeout = setTimeout(() => controller.abort(new Error('timeout')), 120_000);

    // Clean user question (strip <canvas-workspace> snapshot and attachments)
    // so the orchestrator / planner only sees the user's actual words.
    const rawQuestion = String(input.messages.at(-1)?.content || '');
    const cleanQuestion = rawQuestion
      .replace(/\n?<canvas-workspace>[\s\S]*?<\/canvas-workspace>/g, '')
      .split(/\n\nAttached file:/i)[0].trim();

    // Flux orchestrator: for non-trivial build/research requests, dispatch to
    // Ziker / Toki / Hiku / Siku internally before drafting the final answer.
    // The orchestrator handles its own web research (Toki), so we skip the
    // generic planWebSearch path when orchestration runs.
    let orchestratorCtx = null;
    let searchResult = null;
    const isFlux = input.aifluxRoute && bodyModel === 'flux';
    if (isFlux && !controller.signal.aborted) {
      startStream(res, input.model);
      sendEvent(res, { type: 'orchestrator', phase: 'start', label: 'Flux is orchestrating', description: 'Coordinating the AIFLUX team' });
      orchestratorCtx = await runOrchestrator({
        question: cleanQuestion,
        userKeys, envKeys, ollamaConfigured: Boolean(ollamaBaseUrl),
        sendEvent: (ev) => sendEvent(res, ev),
        signal: controller.signal,
        searchCfg: { searchKey: suppliedSearchKey, envSearchKey },
      });
      if (orchestratorCtx?.research?.sources?.length) {
        searchResult = { query: orchestratorCtx.research.query, sources: orchestratorCtx.research.sources };
      }
    } else if (input.searchMode !== 'off' && !shouldBypassSearch(input)) {
      // Standard (non-Flux or trivial-Flux) search path.
      const searchKey = aifluxRoutes ? aifluxRoutes[0].key : (userKeys[input.provider] || envKeys[input.provider] || '');
      startStream(res, input.model);
      sendEvent(res, { type: 'search', phase: 'planning' });
      const query = await planWebSearch(input, searchKey, ollamaBaseUrl, { signal: controller.signal });
      if (query) {
        sendEvent(res, { type: 'search', phase: 'searching', query });
        const sources = await searchWeb(query, suppliedSearchKey || envSearchKey, { signal: controller.signal });
        sendEvent(res, { type: 'sources', query, sources });
        searchResult = { query, sources };
      } else {
        sendEvent(res, { type: 'search', phase: 'skipped' });
      }
    }

    // Errors that justify failing over to the next route: network/5xx/429,
    // provider-side "invalid or omitted terminal usage" style SSE failures,
    // empty streams, and any non-user-auth error from keyless endpoints.
    const isFailoverError = (err, route) => {
      if (!(err instanceof RequestError)) return true; // network/abort/parse
      if (err.status === 401 || err.status === 403) {
        // Auth errors on user-keyed providers are real — don't retry them.
        // On keyless providers (which shouldn't need auth) treat 401/403 as
        // transient infra failures.
        return route?.keyless === true;
      }
      if (err.status === 400) {
        const msg = String(err.message || '').toLowerCase();
        // Retry malformed-stream / model-not-available / usage errors, but
        // never retry validation errors about the user's own request.
        return /terminal usage|invalid.*usage|no text|empty response|did not complete|non.?chat|returned no/.test(msg);
      }
      return err.status === 429 || err.status >= 500;
    };

    const buildAnswerRequest = (route) => {
      const effectiveInput = {
        ...input,
        provider: route.provider,
        model: route.model,
        aifluxRoute: input.aifluxRoute ? { ...input.aifluxRoute, provider: route.provider, model: route.model } : null,
      };
      const orchBlock = orchestratorCtx ? orchestratorContextBlock(orchestratorCtx) : '';
      if (searchResult) {
        // withSearchContext builds its own systemPrompt via buildAssistantPrompt
        // with searchPerformed=true; prepend the AIFLUX member addendum and
        // orchestrator context on top.
        const withCtx = withSearchContext(effectiveInput, searchResult.query, searchResult.sources);
        if (input.aifluxRoute) {
          withCtx.systemPrompt = `${withCtx.systemPrompt}${orchBlock}\n\n${route.memberAddendum}`;
        } else if (orchBlock) {
          withCtx.systemPrompt = `${withCtx.systemPrompt}${orchBlock}`;
        }
        return buildRequest(withCtx, route.key, ollamaBaseUrl);
      }
      const memberPrompt = input.aifluxRoute
        ? buildAssistantPrompt({ provider: route.provider, model: route.model, searchMode: input.searchMode, searchPerformed: false }) + `${orchBlock}\n\n${route.memberAddendum}`
        : (orchBlock ? buildAssistantPrompt({ provider: route.provider, model: route.model, searchMode: input.searchMode, searchPerformed: false }) + orchBlock : undefined);
      return buildRequest({ ...effectiveInput, systemPrompt: memberPrompt }, route.key, ollamaBaseUrl);
    };

    const routes = aifluxRoutes || [{
      provider: input.provider, model: input.model, key: (userKeys[input.provider] || envKeys[input.provider] || ''), keyless: false,
    }];

    let lastError = null;
    let emittedAnyDeltas = false;
    for (let i = 0; i < routes.length; i++) {
      if (controller.signal.aborted) break;
      const route = routes[i];
      let request;
      try {
        request = buildAnswerRequest(route);
      } catch (err) {
        lastError = err;
        continue;
      }
      // Use a shorter timeout for keyless public endpoints so failover is
      // fast when one is down or stalling.
      const routeTimeoutMs = route.keyless ? 20_000 : 120_000;
      const routeController = new AbortController();
      const onAbort = () => routeController.abort();
      controller.signal.addEventListener('abort', onAbort);
      const routeTimer = setTimeout(() => routeController.abort(new Error('route-timeout')), routeTimeoutMs);
      try {
        const upstream = await fetch(request.url, { ...request.options, signal: routeController.signal });
        if (!upstream.ok) {
          const raw = await upstream.text().catch(() => '');
          throw new RequestError(upstream.status >= 500 ? 502 : upstream.status, friendlyUpstreamError(upstream.status, raw, route.key));
        }
        if (!upstream.body) throw new RequestError(502, 'The provider returned an empty response.');
        if (!emittedAnyDeltas) startStream(res, route.model);
        let usedModel = route.model;
        let hasText = false;
        let rawText = '';
        let streamError = null;
        const chunks = request.format === 'ollama' ? readLines(upstream.body) : readSSE(upstream.body);
        for await (const data of chunks) {
          if (routeController.signal.aborted || controller.signal.aborted) break;
          const part = extractChunk(request.format, data);
          if (part.error) {
            const safeMessage = route.key ? String(part.error).replaceAll(route.key, '[redacted]') : String(part.error);
            streamError = new RequestError(502, safeMessage.slice(0, 320));
            break;
          }
          if (route.provider === 'openrouter' && part.model &&
              (part.model === 'openrouter/free' || isNonChatModelId(part.model))) {
            streamError = new RequestError(502, 'OpenRouter returned a safety or utility model instead of a coding assistant. Choose another free model.');
            break;
          }
          if (part.model && part.model !== usedModel) {
            usedModel = part.model;
            // Only announce model swaps for the first route that actually
            // produces tokens, not silent failovers.
            if (emittedAnyDeltas || i === 0) sendEvent(res, { type: 'model', model: usedModel });
          }
          if (part.text) {
            rawText += part.text;
            hasText = true;
            emittedAnyDeltas = true;
            sendEvent(res, { type: 'delta', text: part.text });
          }
          if (part.done) break;
        }
        if (streamError) throw streamError;
        if (routeController.signal.aborted && !controller.signal.aborted) {
          throw new RequestError(504, 'The provider took too long to respond.');
        }
        // Validate the stream actually produced readable text.
        const stripped = rawText.replace(/<af-tool\b[^>]*>[\s\S]*?<\/af-tool>/g, '').trim();
        if (!hasText || (!stripped && rawText.trim().length === 0)) {
          throw new RequestError(502, 'The model returned no text.');
        }
        // Success — close out.
        sendEvent(res, { type: 'done', model: usedModel });
        res.end();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!isFailoverError(err, route) || i === routes.length - 1 || emittedAnyDeltas) break;
        // Silently try the next route (we haven't streamed any answer text
        // yet, so the user won't see a glitch).
        continue;
      } finally {
        clearTimeout(routeTimer);
        controller.signal.removeEventListener('abort', onAbort);
        try { routeController.abort(); } catch { /* already ended */ }
      }
    }

    if (lastError && !res.writableEnded) {
      throw lastError;
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    const message = controller.signal.aborted
      ? 'The provider took too long to respond. Please try again.'
      : error instanceof RequestError ? error.message : 'Could not reach the AI provider. Check your connection and try again.';
    if (!res.headersSent) res.status(error instanceof RequestError ? Math.min(error.status, 599) : 502).json({ error: message });
    else { sendEvent(res, { type: 'error', message }); res.end(); }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

export default app;
