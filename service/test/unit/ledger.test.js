import test from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS, entryHash, verifyChain } from '../../src/ledger.js';

function chain(n) {
  const rows = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const r = { seq: i, document_id: `doc-${i}`, pdf_sha256: `sha-${i}`, issued_at: new Date(Date.UTC(2026, 9, 18, 0, 0, i)), prev_hash: prev };
    r.entry_hash = entryHash({ prevHash: prev, pdfSha256: r.pdf_sha256, documentId: r.document_id, issuedAt: r.issued_at });
    rows.push(r);
    prev = r.entry_hash;
  }
  return rows;
}

test('intact chain verifies', () => {
  assert.deepEqual(verifyChain(chain(5)), { ok: true, entries: 5 });
});

test('editing a PDF hash in the middle is detected at that row', () => {
  const rows = chain(5);
  rows[2].pdf_sha256 = 'forged';
  assert.deepEqual(verifyChain(rows), { ok: false, brokenAtSeq: 3 });
});

test('deleting a row is detected at the next row', () => {
  const rows = chain(5);
  rows.splice(1, 1);
  assert.deepEqual(verifyChain(rows), { ok: false, brokenAtSeq: 3 });
});
