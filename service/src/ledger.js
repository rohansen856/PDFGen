import { sha256 } from './snapshot.js';

export const GENESIS = '0'.repeat(64);

export function entryHash({ prevHash, pdfSha256, documentId, issuedAt }) {
  return sha256(`${prevHash}|${pdfSha256}|${documentId}|${new Date(issuedAt).toISOString()}`);
}

// Append inside the caller's transaction. The advisory lock serialises appends so two workers
// can't both chain onto the same prev_hash.
export async function appendLedger(client, { documentId, pdfSha256, pdfKey }) {
  await client.query('SELECT pg_advisory_xact_lock(7243001)');
  const { rows } = await client.query('SELECT entry_hash FROM pdf_ledger ORDER BY seq DESC LIMIT 1');
  const prevHash = rows[0]?.entry_hash ?? GENESIS;
  const issuedAt = new Date();
  const hash = entryHash({ prevHash, pdfSha256, documentId, issuedAt });
  await client.query(
    `INSERT INTO pdf_ledger (document_id, pdf_sha256, pdf_key, issued_at, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [documentId, pdfSha256, pdfKey, issuedAt, prevHash, hash],
  );
  return { issuedAt, entryHash: hash };
}

// Walk the whole chain. Returns the first broken link, if any.
export function verifyChain(rows) {
  let prev = GENESIS;
  for (const r of rows) {
    const expected = entryHash({
      prevHash: prev, pdfSha256: r.pdf_sha256, documentId: r.document_id, issuedAt: r.issued_at,
    });
    if (r.prev_hash !== prev || r.entry_hash !== expected) return { ok: false, brokenAtSeq: Number(r.seq) };
    prev = r.entry_hash;
  }
  return { ok: true, entries: rows.length };
}
