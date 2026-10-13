import test from 'node:test';
import assert from 'node:assert/strict';
import curated from '../data/models.json' with { type: 'json' };
import { isNonChatModelId, isSelectableOpenRouterId, isUsableFreeCatalogModel } from './model-policy.mjs';

test('curated OpenRouter picks are specific free conversational models', () => {
  for (const model of curated.filter((item) => item.provider === 'openrouter')) {
    assert.equal(isSelectableOpenRouterId(model.id), true, model.id);
    assert.equal(isUsableFreeCatalogModel(model), true, model.id);
  }
  assert.equal(isSelectableOpenRouterId('openrouter/free'), false);
  assert.equal(isSelectableOpenRouterId('openai/gpt-5'), false);
});

test('filters moderation, guardrail, embedding and other non-chat model IDs', () => {
  for (const id of [
    'nvidia/nemotron-3.5-content-safety:free', 'meta/llama-guard-3:free',
    'ollama/llama-guard3:free', 'org/guard-v2:free',
    'org/prompt-guard:free', 'org/safeguard:free', 'org/moderator-v2:free',
    'org/reranking:free', 'org/ranker:free', 'org/embedding-v1:free', 'org/embedder:free',
    'org/classifier:free', 'org/detector:free', 'org/reward:free',
    'org/scorer:free', 'org/utility:free', 'org/image-generation:free',
    'org/transcription:free', 'org/text-to-speech:free', 'org/diffusion:free',
  ]) {
    assert.equal(isNonChatModelId(id), true, id);
    assert.equal(isSelectableOpenRouterId(id), false, id);
  }
  assert.equal(isNonChatModelId('poolside/laguna-s-2.1:free'), false);
});

test('filters mislabeled free endpoints by metadata and output modality', () => {
  assert.equal(isUsableFreeCatalogModel({ id: 'org/generic-v1:free', name: 'Safety Classifier' }), false);
  assert.equal(isUsableFreeCatalogModel({ id: 'org/generic-v1:free', name: 'Generic', description: 'A text embedding model.' }), false);
  assert.equal(isUsableFreeCatalogModel({ id: 'org/generic-v1:free', name: 'Generic', architecture: { output_modalities: ['image'] } }), false);
  assert.equal(isUsableFreeCatalogModel({ id: 'org/coder:free', name: 'Coder', architecture: { output_modalities: ['text'] } }), true);
});
