import test from 'node:test';
import assert from 'node:assert/strict';
import { api, download, nowIso, pdfText, sha256, uniq } from './helpers.js';
import { purchaseOrder } from '../../fixtures/generate.js';

test('rejects calls without the service token', async () => {
  const res = await fetch(`${process.env.API_URL ?? 'http://localhost:8080'}/v1/jobs/x`);
  assert.equal(res.status, 401);
});

test('single PO: 200 with a downloadable PDF inside the 5 s budget', async () => {
  const t0 = Date.now();
  const { status, body } = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: purchaseOrder({ n: uniq(), rows: 20 }) });
  const elapsed = Date.now() - t0;
  assert.equal(status, 200);
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  const pdf = await download(body.download_url);
  assert.equal(pdf.status, 200);
  assert.equal(sha256(pdf.bytes), body.sha256, 'downloaded bytes match the ledgered hash');
  assert.match(pdfText(pdf.bytes), /PURCHASE ORDER/);
});

test('same document at the same ERP version is idempotent (no re-render)', async () => {
  const doc = purchaseOrder({ n: uniq(), rows: 5 });
  const a = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: doc });
  const b = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: doc });
  assert.equal(a.body.job_id, b.body.job_id);
  assert.equal(a.body.sha256, b.body.sha256);
  const c = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: { ...doc, source_version: 'v2' } });
  assert.notEqual(c.body.job_id, a.body.job_id, 'a new ERP version gets a new PDF');
});

test('validation: bulk over 100 documents is rejected', async () => {
  const docs = Array.from({ length: 101 }, (_, i) => purchaseOrder({ n: i, rows: 1 }));
  const { status } = await api('POST', '/v1/bulk', { data_as_of: nowIso(), documents: docs });
  assert.equal(status, 400);
});
