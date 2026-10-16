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
  assert.equal(mergeGeneratedFiles(starter, extractCodeFiles('```html filename="index.html"\n<h1>New</h1>\n```', starter))[0].content, '<h1>New</h1>');
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

test('preview injection survives CSS/JS containing $ replacement patterns', () => {
  // String.replace would expand `$&` / `$1` in file contents and corrupt output.
  const preview = buildPreview([
    file('index.html', '<html><head></head><body><p>hi</p></body></html>'),
    file('style.css', 'p::after { content: "$& $1 $`"; }'),
    file('app.js', 'const t = "$& <head>";'),
  ]);
  assert.match(preview, /content: "\$& \$1 \$`"/);
  assert.match(preview, /const t = "\$& <head>";/);
  assert.doesNotMatch(preview, /content: "<\/head>/);
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
