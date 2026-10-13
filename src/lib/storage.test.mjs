import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('migrates saved random/safety models while retaining named free chat selections', async () => {
  const vite = await createServer({
    configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  });
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    const { hasSavedModel, loadModel, saveModel } = await vite.ssrLoadModule('/src/lib/storage.ts');
    const key = 'aiflux.model.v1';
    const legacy = { provider: 'openrouter', id: 'openrouter/free', name: 'Free model router', shortName: 'Auto free' };
    values.set(key, JSON.stringify(legacy));
    assert.equal(hasSavedModel(), false);
    assert.equal(loadModel().id, 'gemini-3.8-flash');
    assert.equal(values.has(key), false);

    values.set(key, JSON.stringify({ ...legacy, id: 'nvidia/nemotron-3.5-content-safety:free' }));
    assert.equal(loadModel().id, 'gemini-3.8-flash');
    assert.equal(values.has(key), false);

    const coding = { ...legacy, id: 'poolside/laguna-s-2.1:free', name: 'Poolside Laguna S 2.1', shortName: 'Laguna S 2.1' };
    saveModel(coding);
    assert.equal(hasSavedModel(), true);
    assert.equal(loadModel().id, coding.id);
    assert.equal(values.has(key), true);

    values.set(key, JSON.stringify({ ...legacy, provider: 'unsupported', id: 'unknown' }));
    assert.equal(hasSavedModel(), false);
    assert.equal(loadModel().id, 'gemini-3.8-flash');
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    await vite.close();
  }
});

test('web search preference and Tavily key persist with existing session/remember settings', async () => {
  const vite = await createServer({
    configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  });
  const originalLocal = globalThis.localStorage;
  const originalSession = globalThis.sessionStorage;
  const local = new Map();
  const session = new Map();
  const storage = (values) => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  globalThis.localStorage = storage(local);
  globalThis.sessionStorage = storage(session);
  try {
    const { loadSearchMode, saveSearchMode, loadCredentials, saveCredentials } = await vite.ssrLoadModule('/src/lib/storage.ts');
    assert.equal(loadSearchMode(), 'off');
    saveSearchMode('auto');
    assert.equal(loadSearchMode(), 'auto');
    saveSearchMode('always');
    assert.equal(local.get('aiflux.search-mode.v1'), 'always');
    assert.equal(loadSearchMode(), 'always');
    local.set('aiflux.search-mode.v1', 'invalid');
    assert.equal(loadSearchMode(), 'off');
    const credentials = { keys: { openrouter: '', gemini: 'ai-key', groq: '' }, searchKey: 'tavily-key', accessCode: '', remember: false };
    saveCredentials(credentials);
    assert.equal(local.has('aiflux.credentials.v1'), false);
    assert.equal(loadCredentials().searchKey, 'tavily-key');
    saveCredentials({ ...credentials, remember: true });
    assert.equal(session.has('aiflux.credentials.v1'), false);
    assert.equal(local.has('aiflux.credentials.v1'), true);
    assert.equal(loadCredentials().searchKey, 'tavily-key');
    local.set('aiflux.credentials.v1', JSON.stringify({ keys: credentials.keys, remember: true }));
    assert.equal(loadCredentials().searchKey, ''); // Legacy saved settings still work.
  } finally {
    if (originalLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocal;
    if (originalSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = originalSession;
    await vite.close();
  }
});
