import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { api, download, nowIso, pdfText, uniq, waitForJob } from './helpers.js';
import { purchaseOrder } from '../../fixtures/generate.js';

test('1000-line PO is routed to chunked rendering and keeps every line, in order', async () => {
  const doc = purchaseOrder({ n: uniq(), rows: 1000 });
  const { status, body } = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: doc });
  const final = status === 202 ? (await waitForJob(body.job_id)).documents[0] : body;
  assert.equal(final.status, 'done');
  assert.equal(final.render_mode, 'chunked');
  const pdf = await download(final.download_url);
  const text = pdfText(pdf.bytes);
  assert.match(text, /SKU-1000/);
  assert.match(text, /SKU-1999/);
  assert.ok(text.indexOf('SKU-1500') < text.indexOf('SKU-1501'));
  const pages = (await PDFDocument.load(pdf.bytes)).getPageCount();
  assert.match(text, new RegExp(`Page ${pages} of ${pages}`), 'page numbers stamped across merged chunks');
});

test('renderer crash on first attempt -> automatic retry in chunked mode succeeds', async () => {
  // _fault makes the worker kill its Chromium renderer mid-render (only honoured when
  // ALLOW_FAULT_INJECTION=1), which is what a renderer OOM looks like from the outside.
  const doc = purchaseOrder({ n: uniq(), rows: 40, fault: 'crash_single_pass' });
  const { status, body } = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: doc });
  const final = status === 202 ? (await waitForJob(body.job_id, 60_000)).documents[0] : body;
  assert.equal(final.status, 'done');
  assert.equal(final.attempts, 2);
  assert.equal(final.render_mode, 'chunked');
});
