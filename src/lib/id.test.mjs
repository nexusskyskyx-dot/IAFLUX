import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from './id.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('newId returns unique UUIDs when Web Crypto is fully available', () => {
  const ids = new Set(Array.from({ length: 50 }, newId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, UUID_V4);
});

function withCrypto(value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
}

test('newId falls back to getRandomValues when randomUUID is missing', () => {
  // Browsers in an insecure context (plain-HTTP self-hosting) have no randomUUID.
  const id = withCrypto({
    getRandomValues: (array) => {
      for (let index = 0; index < array.length; index += 1) array[index] = (index * 17 + 3) & 0xff;
      return array;
    },
  }, newId);
  assert.match(id, UUID_V4);
});

test('newId still returns a usable id with no Web Crypto at all', () => {
  const id = withCrypto(undefined, newId);
  assert.match(id, /^id-[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(id, withCrypto(undefined, newId));
});

test('newId survives a randomUUID that throws', () => {
  const id = withCrypto({
    randomUUID() { throw new Error('blocked'); },
    getRandomValues: (array) => { array.fill(7); return array; },
  }, newId);
  assert.match(id, UUID_V4);
});
