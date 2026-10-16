import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspaceOperations, buildCanvasContext, buildPreview, downloadProject, extractCodeFiles, extractWorkspaceOperations, filterWorkspaceOperationsForRequest, mergeGeneratedFiles, requestsCanvasMutation, safeFilename, toProviderMessages } from './files.ts';

const file = (name, content, origin = 'user') => ({ id: name, name, content, origin });

test('pulls named fenced files out of AI answers without destroying edited files', () => {
  const existing = [file('index.html', 'My work', 'user')];
  const generated = extractCodeFiles('Here is your app:\n\n```html filename="index.html"\n<h1>Hello</h1>\n```\n\n```css filename="style.css"\nh1 { color: red; }\n```', existing);
  assert.deepEqual(generated.map((item) => item.name), ['index-2.html', 'style.css']);
  assert.equal(mergeGeneratedFiles(existing, generated)[0].content, 'My work');
  const starter = [file('index.html', 'Starter', 'starter')];
  const replacedStarter = mergeGeneratedFiles(starter, extractCodeFiles('```html filename="index.html"\n<h1>New</h1>\n```', starter))[0];
  assert.equal(replacedStarter.content, '<h1>New</h1>');
  assert.equal(replacedStarter.previousContent, 'Starter');
  const newFile = extractCodeFiles('```python filename="tool.py"\nprint("hello")\n```', [])[0];
  assert.equal(newFile.previousContent, '');
  assert.equal(newFile.lastChangedBy, 'ai');
});

test('AI edits only the authorized unchanged Canvas file and preserves a diff baseline', () => {
  const existing = [file('src/App.tsx', 'const value = 1;', 'user')];
  const target = { id: existing[0].id, name: existing[0].name, content: existing[0].content };
  const markdown = '```tsx filename="src/App.tsx"\nconst value = 2;\n```';
  const edited = extractCodeFiles(markdown, existing, [target]);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].id, existing[0].id);
  assert.equal(edited[0].name, 'src/App.tsx');
  assert.equal(edited[0].previousContent, 'const value = 1;');
  assert.equal(edited[0].lastChangedBy, 'ai');
  const merged = mergeGeneratedFiles(existing, edited);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].content, 'const value = 2;');

  const changedSinceAttach = [{ ...existing[0], content: 'const value = 3;' }];
  const version = extractCodeFiles(markdown, changedSinceAttach, [target]);
  assert.equal(version[0].name, 'src/App-2.tsx');
  assert.equal(mergeGeneratedFiles(changedSinceAttach, version)[0].content, 'const value = 3;');
  assert.equal(mergeGeneratedFiles(changedSinceAttach, version)[1].content, 'const value = 2;');
  assert.deepEqual(extractCodeFiles(markdown, [], [target]), [], 'a deleted or renamed snapshot file is not resurrected by a stale response');
});

test('sanitizes file names and infers snippet extensions', () => {
  assert.equal(safeFilename('../../dangerous name.js'), 'dangerous-name.js');
  assert.equal(extractCodeFiles('```python\nprint("hello")\n```', [])[0].name, 'snippet-1.py');
});

test('the full Canvas tree and file contents are automatically attached to every user turn within the context budget', () => {
  const files = [file('src/app.ts', 'const app = true;'), file('index.html', '<main>Home</main>')];
  const snapshot = buildCanvasContext(files, ['empty'], files[0].id);
  assert.match(snapshot.text, /Canvas workspace context \(automatic\): current snapshot of 2 files and 2 folders/);
  assert.match(snapshot.text, /Selected Canvas file: src\/app\.ts/);
  assert.match(snapshot.text, /Workspace folders:[\s\S]*empty\//);
  assert.match(snapshot.text, /BEGIN CANVAS FILE: src\/app\.ts/);
  assert.match(snapshot.text, /BEGIN CANVAS FILE: index\.html/);
  assert.ok(snapshot.text.indexOf('BEGIN CANVAS FILE: src/app.ts') < snapshot.text.indexOf('BEGIN CANVAS FILE: index.html'));
  assert.equal(snapshot.editableFiles.length, 2);
  assert.deepEqual(snapshot.truncatedFiles, []);
  assert.equal(snapshot.manifestTruncated, false);
  const sent = toProviderMessages([
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Update the page' },
  ], snapshot.text);
  assert.doesNotMatch(sent[0].content, /Canvas workspace context \(automatic\)/);
  assert.match(sent[2].content, /Canvas workspace context \(automatic\)/);
  assert.match(sent[2].content, /<main>Home<\/main>/);

  const large = [file('selected.ts', 's'.repeat(600)), file('other.ts', 'o'.repeat(600))];
  const bounded = buildCanvasContext(large, [], large[0].id, 1_600);
  assert.ok(bounded.text.length <= 1_600);
  assert.equal(bounded.editableFiles[0]?.id, 'selected.ts');
  assert.ok(bounded.truncatedFiles.includes('other.ts'));
  assert.match(bounded.text, /context limit/i);

  const oversizedTree = buildCanvasContext(Array.from({ length: 1_000 }, (_, index) => file(`dir${index}/index.ts`, '')));
  assert.equal(oversizedTree.manifestTruncated, true);
  assert.match(oversizedTree.text, /file list truncated/);
});

test('AI workspace operations create, rename, and soft-delete files and folders without creating a bogus code file', () => {
  const files = [file('src/old.ts', 'export const old = true;'), file('keep.txt', 'keep')];
  const answer = '```aiflux-workspace\n{"operations":[{"type":"create-folder","path":"assets/images"},{"type":"rename-file","from":"keep.txt","to":"docs/guide.md"},{"type":"rename-folder","from":"src","to":"app"},{"type":"delete-file","path":"app/old.ts"},{"type":"delete-folder","path":"assets"}]}\n```';
  const operations = extractWorkspaceOperations(answer);
  assert.equal(operations.length, 5);
  assert.equal(extractCodeFiles(answer, files).length, 0);
  const result = applyWorkspaceOperations(files, ['empty'], [], [], operations);
  assert.deepEqual(result.files.map((item) => item.name), ['docs/guide.md']);
  assert.equal(result.deletedFiles[0].name, 'app/old.ts');
  assert.ok(result.deletedFolders.includes('assets'));
  assert.ok(result.deletedFolders.includes('assets/images'));
  assert.ok(result.folders.includes('docs'));
  assert.ok(result.applied.some((entry) => entry.includes('Renamed folder src/ to app/')));
  assert.ok(result.skipped.length === 0);
  assert.equal(extractWorkspaceOperations('```aiflux-workspace\n{"operations":[{"type":"delete-file","path":"../secret.txt"}]}\n```').length, 0);
  assert.equal(requestsCanvasMutation('What files and folders are in this project?'), false);
  assert.equal(requestsCanvasMutation('What would you change in the navigation?'), false);
  assert.equal(requestsCanvasMutation("Don't edit anything; just explain what this file does."), false);
  assert.equal(requestsCanvasMutation('Add a pricing page and update the navigation'), true);
  const authorized = filterWorkspaceOperationsForRequest(operations, 'Create an assets folder and delete the old source file');
  assert.deepEqual(authorized.map((item) => item.type), ['create-folder', 'delete-file', 'delete-folder']);
  assert.deepEqual(filterWorkspaceOperationsForRequest(operations, "Don't delete or rename anything; only explain."), []);
  assert.deepEqual(filterWorkspaceOperationsForRequest(operations, 'What should I add to this folder?'), []);
  const conflicts = applyWorkspaceOperations([file('blocked', 'x'), file('other.ts', 'x')], [], [], [], [
    { type: 'create-folder', path: 'blocked/sub' }, { type: 'rename-file', from: 'other.ts', to: 'blocked/new.ts' },
  ]);
  assert.equal(conflicts.files.find((item) => item.id === 'other.ts').name, 'other.ts');
  assert.equal(conflicts.skipped.length, 2);
});

test('Canvas ZIP export includes empty and nested folders as well as files', async () => {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const previousWindow = globalThis.window;
  const previousCreateObjectURL = URL.createObjectURL;
  const previousRevokeObjectURL = URL.revokeObjectURL;
  let archiveBlob;
  globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) };
  globalThis.window = { setTimeout() {} };
  URL.createObjectURL = (blob) => { archiveBlob = blob; return 'blob:project'; };
  URL.revokeObjectURL = () => {};
  try {
    await downloadProject([file('src/index.ts', 'export {};')], ['empty', 'assets/images']);
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(archiveBlob);
    assert.ok(archive.files['empty/']);
    assert.ok(archive.files['assets/']);
    assert.ok(archive.files['assets/images/']);
    assert.ok(archive.files['src/index.ts']);
  } finally {
    if (hadDocument) globalThis.document = previousDocument; else delete globalThis.document;
    if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window;
    URL.createObjectURL = previousCreateObjectURL;
    URL.revokeObjectURL = previousRevokeObjectURL;
  }
});

test('sandbox preview wraps HTML fragments and includes CSS/JS with a restrictive CSP', () => {
  const preview = buildPreview([file('index.html', '<h1>Hello</h1>'), file('style.css', 'h1 { color: red; }'), file('app.js', 'document.querySelector("h1").textContent = "Hi";')]);
  assert.match(preview, /Content-Security-Policy/);
  assert.ok(preview.indexOf('Content-Security-Policy') < preview.indexOf('<h1>Hello'));
  assert.match(preview, /connect-src 'none'/);
  assert.match(preview, /img-src data: blob:/);
  assert.doesNotMatch(preview, /img-src data: blob: https:/);
  assert.match(preview, /<style>h1 \{ color: red; \}<\/style>/);
  assert.match(preview, /<script>document.querySelector/);
  assert.equal(buildPreview([file('app.py', 'print(1)')]), null);
});

test('remote-image opt-in permits HTTPS image sources only while other network access stays blocked', () => {
  const preview = buildPreview([file('index.html', '<img src="https://images.example/photo.jpg" alt="A photo">')], { allowRemoteImages: true });
  assert.match(preview, /img-src data: blob: https:/);
  assert.match(preview, /connect-src 'none'/);
  assert.match(preview, /form-action 'none'/);
  assert.doesNotMatch(preview, /script-src https:/);
});

test('Canvas attachments are clearly labeled as visible edit targets and stale copies are removed from history', () => {
  const result = toProviderMessages([
    { role: 'user', content: 'Make this better', attachments: [{ name: 'index.html', content: '<h1>Old</h1>', canvasFileId: 'canvas-1' }] },
    { role: 'assistant', content: 'I can see index.html. What should change?', status: 'done' },
    { role: 'user', content: 'Make the hero more colorful', attachments: [{ name: 'index.html', content: '<h1>Current</h1>', canvasFileId: 'canvas-1' }] },
  ]);
  assert.doesNotMatch(result[0].content, /<h1>Old<\/h1>/);
  assert.match(result[2].content, /Canvas file attached for editing: index\.html/);
  assert.match(result[2].content, /complete current contents are included below/i);
  assert.match(result[2].content, /<h1>Current<\/h1>/);

  const partial = toProviderMessages([{ role: 'user', content: 'Review', attachments: [{ name: 'large.html', content: '<main>partial</main>', canvasPartial: true }] }]);
  assert.match(partial[0].content, /Canvas file attached for context only \(partial\): large\.html/);
  assert.match(partial[0].content, /cannot be safely applied as a full-file edit/);
});

test('conversation history includes attachments but skips failed assistant messages', () => {
  const result = toProviderMessages([
    { role: 'user', content: 'Review this', attachments: [{ name: 'test.py', content: 'print(1)' }] },
    { role: 'assistant', content: 'provider error', status: 'error' },
    { role: 'user', content: 'Try again' },
  ]);
  assert.equal(result.length, 2);
  assert.match(result[0].content, /Attached file: test.py/);
  assert.equal(result[1].content, 'Try again');
});
