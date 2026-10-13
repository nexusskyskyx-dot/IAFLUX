import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const model = { id: 'gemini-2.5-flash', provider: 'gemini', name: 'Gemini 2.5 Flash', shortName: 'Gemini Flash', description: '', strength: '', badge: '' };

test('chat displays the search mode, trusted source links, and honest skipped-search status', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: ChatPanel } = await vite.ssrLoadModule('/src/components/ChatPanel.tsx');
    const conversation = {
      id: 'test-chat', title: 'Search', createdAt: 1, updatedAt: 1, files: [], selectedFileId: null,
      messages: [
        { id: '1', role: 'user', content: 'What changed?', createdAt: 1 },
        { id: '2', role: 'assistant', content: 'Read the source.', status: 'done', createdAt: 2, search: {
          query: 'Latest release notes', sources: [
            { title: 'Official release notes', url: 'https://example.org/notes', snippet: 'Updated documentation.' },
            { title: 'Unsafe link', url: 'javascript:alert(1)', snippet: 'Must not render.' },
          ],
        } },
        { id: '3', role: 'user', content: 'Build a button', createdAt: 3 },
        { id: '4', role: 'assistant', content: 'Here is a button.', status: 'done', createdAt: 4, searchSkipped: true },
      ],
    };
    const props = {
      conversation, selectedModel: model, models: [model], catalogAvailable: true,
      connected: true, sending: false, searchMode: 'auto', onCycleSearchMode() {},
      contextFile: null, isConnected: () => true, onSend: () => true, onStop() {},
      onSelectModel() {}, onLoadModels() {}, onLibrary() {}, onOpenSnippet() {},
      onClearContext() {}, onNotify() {}, onSettings() {},
    };
    const html = renderToStaticMarkup(React.createElement(ChatPanel, props));
    assert.match(html, /Web search auto\. Switch to Always/);
    assert.match(html, /LIVE WEB SEARCH/);
    assert.match(html, /href="https:\/\/example.org\/notes"/);
    assert.match(html, /Official release notes/);
    assert.match(html, /No live web search used for this answer/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.doesNotMatch(html, /Unsafe link/);
  } finally { await vite.close(); }
});

test('settings explain optional keyless Tavily search and offer a private key field', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: SettingsModal } = await vite.ssrLoadModule('/src/components/SettingsModal.tsx');
    const credentials = { keys: { openrouter: '', gemini: 'model-key', groq: '' }, accessCode: '', searchKey: '', remember: false };
    const config = { configured: { openrouter: false, gemini: false, groq: false }, ollamaConfigured: false, searchConfigured: false, requiresAccessCode: false };
    const html = renderToStaticMarkup(React.createElement(SettingsModal, { credentials, config, onSave() {}, onClose() {} }));
    assert.match(html, /LIVE WEB SEARCH/);
    assert.match(html, /Keyless available/);
    assert.match(html, /Optional Tavily API key/);
    assert.match(html, /type="password"[^>]*aria-label="Tavily search API key"/);
    assert.match(html, /query goes to Tavily/);
  } finally { await vite.close(); }
});
