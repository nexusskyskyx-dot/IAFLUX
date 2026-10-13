// Shared by the browser and API. A :free price does not mean a model is a
// conversational assistant: OpenRouter also lists moderation and utility models.
const NON_CHAT_ID = /(?:^|[/\s:._-])(?:content[-_]?safety|safety|safeguard|moderation|moderator|prompt[-_]?guard|guardrail|guard(?:[-_]?v?\d+)?|rerank(?:er|ing)?|ranker|embedd?(?:er|ing|ings)?|classifier|reward|detector|scorer|utility|nsfw|ocr|transcrib(?:e|er)|transcription|speech[-_]?to[-_]?text|text[-_]?to[-_]?speech|text[-_]?to[-_]?image|image[-_]?generat(?:or|ion)|tts|diffusion)(?=$|[/\s:._-])/i;
const NON_CHAT_DESCRIPTION = /(?:moderates? (?:both )?(?:inputs|prompts|responses)|safe\/unsafe classification|(?:content|prompt) safety classifier|(?:text|image|audio) embedding model|rerank(?:ing|er) model|image generation model|speech synthesis model)/i;
const FREE_ID = /^[a-zA-Z0-9._/-]+:free$/;

/** @param {string} id */
export function isNonChatModelId(id) {
  return typeof id !== 'string' || NON_CHAT_ID.test(id);
}

/** @param {string} id */
export function isSelectableOpenRouterId(id) {
  return typeof id === 'string' && FREE_ID.test(id) && !isNonChatModelId(id);
}

/**
 * @param {{id?: string, name?: string, description?: string, architecture?: {output_modalities?: string[]}}} model
 */
export function isUsableFreeCatalogModel(model) {
  if (!model || !isSelectableOpenRouterId(model.id)) return false;
  if (isNonChatModelId(model.name || '') || NON_CHAT_DESCRIPTION.test(model.description || '')) return false;
  const outputs = model.architecture?.output_modalities;
  return !Array.isArray(outputs) || outputs.includes('text');
}
