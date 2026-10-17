import test from 'node:test';
import assert from 'node:assert/strict';
import { API, AUTH, api, download, nowIso, pdfText, sha256, uniq, waitForJob } from './helpers.js';
import { invoice, purchaseOrder } from '../../fixtures/generate.js';

async function collectSse(jobId) {
  const res = await fetch(`${API}/v1/jobs/${jobId}/events`, { headers: AUTH });
  const events = [];
  let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
      buf = buf.slice(i + 2);
    }
  }
  return events;
}

test('bulk of 100: progress events, full zip, 25-doc parts, manifest hashes', async () => {
  const docs = Array.from({ length: 100 }, (_, i) =>
    i % 2 ? invoice({ n: uniq(), rows: 5 + (i % 40) }) : purchaseOrder({ n: uniq(), rows: 5 + (i % 60) }));
  const { status, body } = await api('POST', '/v1/bulk', { data_as_of: nowIso(), documents: docs }, { 'idempotency-key': `t-${uniq()}` });
  assert.equal(status, 202);

  const events = await collectSse(body.job_id);
  const pct = events.map((e) => e.progress.percent);
  assert.ok(events.length >= 3, 'several progress updates were pushed');
  assert.deepEqual(pct, [...pct].sort((a, b) => a - b), 'progress never goes backwards');
  assert.equal(events.at(-1).status, 'completed');

  const job = await waitForJob(body.job_id);
  assert.equal(job.progress.done, 100);
  assert.equal(job.downloads.parts.length, 4);

  const manifest = JSON.parse((await download(job.downloads.manifest_url)).bytes);
  assert.equal(manifest.files.length, 100);
  assert.equal(manifest.failures.length, 0);
  const bySeq = new Map(job.documents.map((d) => [d.seq, d.sha256]));
  for (const f of manifest.files) assert.equal(f.sha256, bySeq.get(f.seq));
});

test('interrupted zip download resumes with an HTTP Range request', async () => {
  const docs = Array.from({ length: 30 }, () => purchaseOrder({ n: uniq(), rows: 30 }));
  const { body } = await api('POST', '/v1/bulk', { data_as_of: nowIso(), documents: docs });
  const job = await waitForJob(body.job_id);
  const full = await download(job.downloads.zip_url);
  const cut = Math.floor(full.bytes.length * 0.6); // connection "drops" at 60%
  const rest = await download(job.downloads.zip_url, { range: `bytes=${cut}-` });
  assert.equal(rest.status, 206, 'object store honours Range on presigned URLs');
  const resumed = Buffer.concat([full.bytes.subarray(0, cut), rest.bytes]);
  assert.equal(sha256(resumed), sha256(full.bytes));
});

test('data consistency: ERP edits after the bulk is triggered do not leak into its PDFs', async () => {
  // Bulk snapshot: every invoice line at ₹100.
  const refs = Array.from({ length: 20 }, () => uniq());
  const docs = refs.map((n) => invoice({ n, rows: 3, unitRate: 100, version: 'v1' }));
  const { body } = await api('POST', '/v1/bulk', { data_as_of: nowIso(), documents: docs });

  // Meanwhile the ERP changes the last invoice to ₹999 and the user downloads it individually.
  const edited = invoice({ n: refs.at(-1), rows: 3, unitRate: 999, version: 'v2' });
  const single = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: edited });

  const job = await waitForJob(body.job_id);
  const last = job.documents.at(-1);
  const bulkText = pdfText((await download(last.download_url)).bytes);
  assert.match(bulkText, /₹100\.00/);
  assert.doesNotMatch(bulkText, /₹999/);
  assert.match(bulkText, /snapshot [0-9a-f]{12}/, 'footer names the snapshot it was rendered from');
  const singleUrl = single.body.download_url ?? (await waitForJob(single.body.job_id)).documents[0].download_url;
  assert.match(pdfText((await download(singleUrl)).bytes), /₹999\.00/);
});
