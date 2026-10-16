import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const model = { id: 'gemini-2.5-flash', provider: 'gemini', name: 'Gemini 2.5 Flash', shortName: 'Gemini Flash', description: '', strength: '', badge: '' };

test('AIFLUX branding defines black as primary and the uploaded mark’s purple as secondary', async () => {
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const brand = await readFile(new URL('../../public/brand-mark.svg', import.meta.url), 'utf8');
  const component = await readFile(new URL('../components/Brand.tsx', import.meta.url), 'utf8');
  assert.match(styles, /--primary:\s*#070708/);
  assert.match(styles, /--secondary:\s*#6d35f4/);
  assert.match(brand, /fill="#070708"/);
  assert.match(brand, /fill="#fff"/);
  assert.match(brand, /fill="#6d35f4"/);
  assert.match(component, /src="\/brand-mark\.svg"/);
});

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
        { id: '5', role: 'assistant', content: 'Removed the unused file.\n\n```aiflux-workspace\n{"operations":[{"type":"delete-file","path":"old.ts"}]}\n```', status: 'done', createdAt: 5 },
      ],
    };
    const props = {
      conversation, selectedModel: model, models: [model], catalogAvailable: true,
      connected: true, sending: false, searchMode: 'auto', onCycleSearchMode() {},
      contextFile: null, isConnected: () => true, onSend: () => true, onStop() {},
      onSelectModel() {}, onLoadModels() {}, onLibrary() {}, onOpenSnippet() {},
      onClearContext() {}, onNotify() {}, onSettings() {}, onGitHub() {},
    };
    const html = renderToStaticMarkup(React.createElement(ChatPanel, props));
    assert.match(html, /Web search auto\. Switch to Always/);
    assert.match(html, /Canvas auto-shared \(0 files\)/);
    assert.match(html, /Context\+ plus live search when useful\./);
    assert.match(html, /LIVE WEB SEARCH/);
    assert.match(html, /href="https:\/\/example.org\/notes"/);
    assert.match(html, /Official release notes/);
    assert.match(html, /No live web search used for this answer/);
    assert.match(html, /Canvas workspace actions/);
    assert.match(html, /Delete file old\.ts/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.doesNotMatch(html, /Unsafe link/);
    assert.match(html, /aria-label="Browse GitHub context"/);
    const canvasContextHtml = renderToStaticMarkup(React.createElement(ChatPanel, {
      ...props, contextFile: { name: 'index.html', content: '<h1>Current</h1>', canvasFileId: 'canvas-1' },
    }));
    assert.match(canvasContextHtml, /Canvas · index\.html/);
    assert.match(canvasContextHtml, /Full Canvas file attached for editing/);
  } finally { await vite.close(); }
});

test('settings explain optional keyless Tavily search and offer a private key field', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: SettingsModal } = await vite.ssrLoadModule('/src/components/SettingsModal.tsx');
    const credentials = { keys: { openrouter: '', xkiro: 'xkiro-key', gemini: 'model-key', groq: '' }, accessCode: '', searchKey: '', remember: false, autoSelectOnConnect: true };
    const config = { configured: { openrouter: false, xkiro: false, gemini: false, groq: false }, ollamaConfigured: false, searchConfigured: false, requiresAccessCode: false };
    const html = renderToStaticMarkup(React.createElement(SettingsModal, { credentials, config, onSave() {}, onClose() {} }));
    assert.match(html, /LIVE WEB SEARCH/);
    assert.match(html, /Keyless available/);
    assert.match(html, /Optional Tavily API key/);
    assert.match(html, /type="password"[^>]*aria-label="Tavily search API key"/);
    assert.match(html, /query goes to Tavily/);
    assert.match(html, /xKiro/);
    assert.match(html, /daily token allowance applies/);
    assert.match(html, /xkiro\.com\/dashboard\/api\/keys/);
    assert.match(html, /Auto-select a recommended model on connect/);
  } finally { await vite.close(); }
});

test('Canvas exposes an explicit GitHub publishing action with a review-before-publish dialog', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: Canvas } = await vite.ssrLoadModule('/src/components/Canvas.tsx');
    const { default: GitHubPublishModal } = await vite.ssrLoadModule('/src/components/GitHubPublishModal.tsx');
    const file = { id: 'file-1', name: 'index.html', content: '<h1>New</h1>', previousContent: '<h1>Old</h1>', lastChangedBy: 'ai', origin: 'generated' };
    const deletedFile = { id: 'file-2', name: 'old.html', content: '<h1>Old</h1>', origin: 'user' };
    const conversation = { id: 'test-chat', title: 'Publish', createdAt: 1, updatedAt: 1, files: [file], folders: ['assets'], deletedFiles: [deletedFile], deletedFolders: ['archive'], selectedFileId: file.id, messages: [] };
    const canvasHtml = renderToStaticMarkup(React.createElement(Canvas, {
      conversation, mobileOpen: false, onClose() {}, onSelectFile() {}, onUpdateFile() {}, onRestoreFile() {},
      onCreateFile() {}, onCreateFolder() {}, onDeleteFile() {}, onDeleteFolder() {}, onRestoreDeletedFile() {}, onRestoreDeletedFolder() {}, onNotify() {}, onPublishGitHub() {},
    }));
    assert.match(canvasHtml, /Review and publish Canvas files to GitHub/);
    assert.match(canvasHtml, /aria-label="Canvas modes"/);
    for (const mode of ['VIEW', 'EDIT', 'TEST', 'DIFF']) assert.match(canvasHtml, new RegExp(`${mode}<\\/button>`));
    assert.match(canvasHtml, /FULL CANVAS AUTO-SHARED · 1 FILE · 1 FOLDER/);
    assert.match(canvasHtml, /assets\//);
    assert.match(canvasHtml, /Recently deleted/);
    assert.match(canvasHtml, /Restore old\.html/);
    const { default: CanvasDiff } = await vite.ssrLoadModule('/src/components/CanvasDiff.tsx');
    const diffHtml = renderToStaticMarkup(React.createElement(CanvasDiff, { file, onRestore() {} }));
    assert.match(diffHtml, /diff-added/);
    assert.match(diffHtml, /diff-removed/);
    assert.match(diffHtml, /New/);
    assert.match(diffHtml, /Old/);
    assert.match(diffHtml, /Restore the saved previous version/);
    const modalHtml = renderToStaticMarkup(React.createElement(GitHubPublishModal, {
      files: [], onClose() {}, onNotify() {}, onConnect() {},
    }));
    assert.match(modalHtml, /REVIEW BEFORE PUBLISH/);
    assert.match(modalHtml, /Nothing is written to GitHub until you review and confirm/);
  } finally { await vite.close(); }
});
