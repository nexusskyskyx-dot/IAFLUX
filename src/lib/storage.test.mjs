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
