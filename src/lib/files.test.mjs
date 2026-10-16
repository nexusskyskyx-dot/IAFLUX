import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview, extractCodeFiles, mergeGeneratedFiles, safeFilename, toProviderMessages } from './files.ts';

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

test('AI edits only the explicitly attached unchanged Canvas file and preserves a diff baseline', () => {
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
});

test('sanitizes file names and infers snippet extensions', () => {
  assert.equal(safeFilename('../../dangerous name.js'), 'dangerous-name.js');
  assert.equal(extractCodeFiles('```python\nprint("hello")\n```', [])[0].name, 'snippet-1.py');
});

test('sandbox preview wraps HTML fragments and includes CSS/JS with a restrictive CSP', () => {
  const preview = buildPreview([file('index.html', '<h1>Hello</h1>'), file('style.css', 'h1 { color: red; }'), file('app.js', 'document.querySelector("h1").textContent = "Hi";')]);
  assert.match(preview, /Content-Security-Policy/);
  assert.ok(preview.indexOf('Content-Security-Policy') < preview.indexOf('<h1>Hello'));
  assert.match(preview, /connect-src 'none'/);
  assert.match(preview, /<style>h1 \{ color: red; \}<\/style>/);
  assert.match(preview, /<script>document.querySelector/);
  assert.equal(buildPreview([file('app.py', 'print(1)')]), null);
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
