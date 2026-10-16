import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDesignRequest, DESIGN_PLAYBOOK, DESIGN_REFERENCES, describeReferences } from './design-profile.mjs';

test('requests that are design work are recognised', () => {
  for (const text of [
    'Build me a landing page',
    'Make this website look modern',
    'Design a portfolio site',
    'Restyle the hero section',
    'I need a pricing page',
    'Make a React component for the navbar',
    'Fix the CSS on index.html',
    'Make the layout responsive',
    'Design a dashboard',
    'Redesign my homepage',
    'Make it look better',
  ]) {
    assert.equal(isDesignRequest(text), true, text);
  }
});

test('requests that are not design work are left alone', () => {
  for (const text of [
    'Why is my API returning a 500 error?',
    'Debug this stack trace',
    'Write a SQL query to find duplicate users',
    'Explain how this regex works',
    'Deploy the app with Docker',
    'Fix the bug in my unit test',
    'What is the capital of Guatemala?',
  ]) {
    assert.equal(isDesignRequest(text), false, text);
  }
});

test('an empty or non-string request is not design work', () => {
  for (const value of ['', '   ', undefined, null, 42]) assert.equal(isDesignRequest(value), false);
});

test('editing a markup file counts as design work even when the wording is plain', () => {
  assert.equal(isDesignRequest('Update styles.css'), true);
  assert.equal(isDesignRequest('have a look at app.jsx'), true);
  assert.equal(isDesignRequest('refactor this function'), false, 'a plain code refactor is not a page');
});

test('the galleries are described with real, reachable URLs', () => {
  const described = describeReferences();
  assert.match(described, /https:\/\/land-book\.com\//);
  assert.match(described, /https:\/\/godly\.design\//);
  assert.match(described, /https:\/\/www\.awwwards\.com\//);
  assert.match(described, /landing page https:\/\/land-book\.com\/design\/landing-page/, 'with the page-type index');
  assert.match(described, /https:\/\/land-book\.com\/sections/, 'and the section library');
  for (const reference of DESIGN_REFERENCES) {
    assert.match(reference.url, /^https:\/\//);
    assert.ok(reference.note.length > 40, `${reference.name} explains itself`);
  }
});

test('the playbook names the section vocabulary and an accessibility floor', () => {
  for (const section of ['hero', 'value proposition', 'pricing', 'FAQ', 'footer']) {
    assert.match(DESIGN_PLAYBOOK, new RegExp(section));
  }
  assert.match(DESIGN_PLAYBOOK, /4\.5:1/);
  assert.match(DESIGN_PLAYBOOK, /prefers-reduced-motion/);
  assert.match(DESIGN_PLAYBOOK, /system font stack|@font-face/);
});
