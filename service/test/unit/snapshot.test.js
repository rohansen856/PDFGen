import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, jobSnapshotHash, sha256 } from '../../src/snapshot.js';

test('canonical JSON ignores key order at every level', () => {
  const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: 'é' } };
  const b = { a: { x: 'é', y: [1, { p: 1, q: 2 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256(canonicalJson(a)), sha256(canonicalJson(b)));
});

test('canonical JSON keeps array order (line item order is meaningful)', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('job snapshot hash changes if any document payload changes', () => {
  const h1 = jobSnapshotHash('2026-10-18T09:00:00Z', ['aa', 'bb']);
  assert.notEqual(h1, jobSnapshotHash('2026-10-18T09:00:00Z', ['aa', 'bc']));
  assert.notEqual(h1, jobSnapshotHash('2026-10-18T09:00:01Z', ['aa', 'bb']));
});
