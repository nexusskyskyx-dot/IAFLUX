import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// The overlay is rendered through a portal, which the server renderer cannot
// do, so these cover the panel itself plus the device table it is driven by.
const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });
const { default: FullPreview, FullPreviewPanel, DEVICES, frameWidth } = await vite.ssrLoadModule('/src/components/FullPreview.tsx');
const { buildPreview } = await vite.ssrLoadModule('/src/lib/files.ts');

const PREVIEW = buildPreview([
  { id: '1', name: 'index.html', content: '<h1>Hello</h1>', origin: 'generated' },
  { id: '2', name: 'styles.css', content: 'h1 { color: red }', origin: 'generated' },
]);

function render(device = 'full') {
  return renderToStaticMarkup(React.createElement(FullPreviewPanel, {
    preview: PREVIEW, device, onDevice() {}, onRefresh() {}, onClose() {}, reloadKey: 0, closeRef: { current: null },
  }));
}

test.after(() => vite.close());

test('the overlay is announced as a dialog', () => {
  const html = render();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Full preview of your project"/);
});

test('the page is shown in the same sandbox as the small preview', () => {
  const html = render();
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.match(html, /<iframe[^>]*srcDoc=/, 'the built document is inline');
  assert.doesNotMatch(html, /allow-same-origin/, 'and it never gets same-origin access');
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
});

test('the whole document reaches the frame, CSS included', () => {
  const html = render();
  assert.match(html, /Hello/, 'the html');
  assert.match(html, /color: ?red/, 'the stylesheet is inlined into it');
});

test('every device preset is offered, and the active one is marked', () => {
  const html = render('tablet');
  for (const device of DEVICES) {
    assert.match(html, new RegExp(`aria-label="${device.title.replace(/[—]/g, '&#x2014;')}"|aria-label="${device.title}"`), device.title);
  }
  const pressed = [...html.matchAll(/aria-pressed="(true|false)"/g)].map((match) => match[1]);
  assert.equal(pressed.filter((value) => value === 'true').length, 1, 'exactly one is pressed');
  assert.match(html, /class="active"/);
});

test('the frame is only constrained when a width is chosen', () => {
  assert.doesNotMatch(render('full'), /full-preview-frame" style=/, 'full fills the window');
  for (const device of ['laptop', 'tablet', 'mobile']) {
    assert.match(render(device), new RegExp(`full-preview-frame" style="width:${frameWidth(device)}px"`), `${device} sets its width`);
  }
});

test('the presets are real breakpoints a layout can break at', () => {
  assert.equal(frameWidth('laptop'), 1280);
  assert.equal(frameWidth('tablet'), 834);
  assert.equal(frameWidth('mobile'), 390);
  assert.equal(frameWidth('full'), null);
  assert.equal(frameWidth('nonsense'), null, 'an unknown id falls back to filling the window');
});

test('reload, new tab and close are all reachable', () => {
  const html = render();
  assert.match(html, /aria-label="Reload the page"/);
  assert.match(html, /aria-label="Open in a new browser tab"/);
  assert.match(html, /aria-label="Exit full preview \(Esc\)"/);
});

test('the way out is labelled, not just another icon', () => {
  const html = render();
  // Three identical icon buttons gave no clue which one was the exit, so the
  // exit carries a word and its own styling, and the footer repeats the hint.
  assert.match(html, /class="full-preview-exit"[^>]*>[\s\S]*?Exit full preview/, 'it says what it does');
  assert.match(html, /<kbd>Esc<\/kbd>/, 'and names the keyboard shortcut on the button');
  assert.match(html, /Press <kbd>Esc<\/kbd>, use Exit, or click the dark area/);

  const exit = html.match(/<button[^>]*class="full-preview-exit"[\s\S]*?<\/button>/)?.[0] || '';
  assert.ok(!/class="full-preview-icon"/.test(exit), 'the exit is not styled like the other two');
  const icons = [...html.matchAll(/class="full-preview-icon"/g)].length;
  assert.equal(icons, 2, 'reload and new tab stay icon-only, so the exit stands apart');
});

test('the overlay says what the sandbox does and does not allow', () => {
  assert.match(render(), /Sandboxed: no network, no access to your workspace/);
});

test('nothing is rendered when there is no page to show', () => {
  assert.equal(renderToStaticMarkup(React.createElement(FullPreview, { preview: null, onClose() {} })), '');
});
