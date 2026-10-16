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
        // Mid-continuation: the answer is being picked back up, not restarted.
        { id: '5', role: 'assistant', content: 'Half of a long file…', status: 'streaming', createdAt: 5, continuation: 2 },
        // Ran out of attempts at the request limit.
        { id: '6', role: 'assistant', content: 'The rest is still missing.', status: 'done', createdAt: 6, truncated: true },
        // Wrote one file, failed to patch another.
        { id: '7', role: 'assistant', content: 'Done — two files touched.', status: 'done', createdAt: 7, fileOps: [
          { path: 'index.html', action: 'write', status: 'applied', added: 12, removed: 4, diff: [] },
          { path: 'app.js', action: 'patch', status: 'failed', added: 0, removed: 0, diff: [], error: 'Could not find the lines to change in app.js.' },
        ] },
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
    assert.match(html, /Picking the answer back up \(3 of 5\)/, 'a resumed answer says so instead of looking stuck');
    assert.match(html, /everything written so far is kept/);
    assert.match(html, /reached the time limit before the model finished/, 'a cut-short answer is not passed off as finished');
    // Files land on the canvas, so the chat shows a chip instead of the code.
    assert.match(html, /file-op-chip applied/);
    assert.match(html, /file-op-chip failed/);
    assert.match(html, /index\.html/);
    assert.match(html, /\+12/);
    assert.match(html, /\u22124/, 'the removed-line count is shown');
    assert.match(html, /Could not find the lines to change in app\.js\./, 'a failed write explains itself');
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

test('the canvas marks the files the assistant changed and can show the diff', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: Canvas } = await vite.ssrLoadModule('/src/components/Canvas.tsx');
    const conversation = {
      id: 'c', title: 'Canvas', createdAt: 1, updatedAt: 1, selectedFileId: 'f1',
      files: [
        { id: 'f1', name: 'index.html', content: '<h1>Hi</h1>', origin: 'generated' },
        { id: 'f2', name: 'app.js', content: 'const a = 1;', origin: 'user' },
      ],
      messages: [{ id: '1', role: 'assistant', content: 'Wrote it.', status: 'done', createdAt: 1, fileOps: [
        { path: 'index.html', action: 'write', status: 'applied', added: 2, removed: 0, diff: [{ kind: 'add', text: '<h1>Hi</h1>', after: 1 }] },
      ] }],
    };
    const props = {
      conversation, mobileOpen: false, onClose() {}, onSelectFile() {}, onUpdateFile() {},
      onCreateFile() {}, onDeleteFile() {}, onAddContext() {}, onNotify() {},
    };
    const html = renderToStaticMarkup(React.createElement(Canvas, props));
    assert.match(html, /file-change-badge/, 'the changed file is badged in the file list');
    assert.match(html, /\+2/);
    // Added and removed counts must carry their own colours: a single coloured
    // badge paints deletions green along with additions.
    assert.match(html, /class="diff-added">\+2</, 'the added count is coloured as an addition');
    assert.match(html, /Show what the assistant changed/, 'a diff toggle is offered for that file');
    assert.equal((html.match(/file-change-badge/g) || []).length, 1, 'only the file the assistant changed is badged');
  } finally { await vite.close(); }
});

test('canvas badges colour deletions red, not green', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
  try {
    const { default: Canvas } = await vite.ssrLoadModule('/src/components/Canvas.tsx');
    const render = (fileOps) => renderToStaticMarkup(React.createElement(Canvas, {
      conversation: {
        id: 'c', title: 'Canvas', createdAt: 1, updatedAt: 1, selectedFileId: 'f1',
        files: [{ id: 'f1', name: 'app.js', content: 'const a = 1;', origin: 'generated' }],
        messages: [{ id: '1', role: 'assistant', content: 'Done.', status: 'done', createdAt: 1, fileOps }],
      },
      mobileOpen: false, onClose() {}, onSelectFile() {}, onUpdateFile() {},
      onCreateFile() {}, onDeleteFile() {}, onAddContext() {}, onNotify() {},
    }));
    const badge = (html) => html.slice(html.indexOf('file-change-badge'), html.indexOf('file-change-badge') + 220);

    const edits = badge(render([{ path: 'app.js', action: 'patch', status: 'applied', added: 3, removed: 7, diff: [] }]));
    assert.match(edits, /class="diff-added">\+3</);
    assert.match(edits, /class="diff-removed">\u22127</);
    assert.ok(edits.indexOf('diff-added') < edits.indexOf('diff-removed'), 'additions come first');

    // A pure deletion must not fall back to the green addition colour.
    const deleted = badge(render([{ path: 'app.js', action: 'delete', status: 'applied', added: 0, removed: 4, diff: [] }]));
    assert.match(deleted, /class="diff-removed">\u22124</);
    assert.doesNotMatch(deleted, /diff-added/, 'nothing green when nothing was added');

    const added = badge(render([{ path: 'app.js', action: 'write', status: 'applied', added: 5, removed: 0, diff: [] }]));
    assert.match(added, /class="diff-added">\+5</);
    assert.doesNotMatch(added, /diff-removed/, 'no empty removal count');
  } finally { await vite.close(); }
});
