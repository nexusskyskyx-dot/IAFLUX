import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('recommended model follows provider rankings and prefers coding-focused choices', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { CURATED_MODELS, recommendedModelForProvider } = await vite.ssrLoadModule('/src/lib/models.ts');
    assert.equal(recommendedModelForProvider('openrouter', CURATED_MODELS)?.id, 'poolside/laguna-s-2.1:free');
    assert.equal(recommendedModelForProvider('gemini', CURATED_MODELS)?.id, 'gemini-3.8-flash');
    assert.equal(recommendedModelForProvider('groq', CURATED_MODELS)?.id, 'qwen/qwen3.8-27b');
    const dynamicXkiro = [
      { id: 'general', provider: 'xkiro', badge: 'FREE', strength: 'General use' },
      { id: 'coder', provider: 'xkiro', badge: 'FREE', strength: 'Coding focused' },
    ];
    assert.equal(recommendedModelForProvider('xkiro', dynamicXkiro)?.id, 'coder');
    assert.equal(recommendedModelForProvider('ollama', CURATED_MODELS), undefined);
    assert.equal(recommendedModelForProvider('gemini', [
      { id: 'paid', provider: 'gemini', badge: 'CHECK PRICING', strength: 'Coding focused' },
    ]), undefined);
  } finally { await vite.close(); }
});
