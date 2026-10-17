import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { api, download, nowIso, uniq } from './helpers.js';
import { purchaseOrder } from '../../fixtures/generate.js';

const s3 = new S3Client({
  endpoint: 'http://localhost:9000', region: 'ap-south-1', forcePathStyle: true,
  credentials: { accessKeyId: 'rustfsadmin', secretAccessKey: 'rustfsadmin' },
});

async function issue() {
  const { body } = await api('POST', '/v1/documents', { data_as_of: nowIso(), document: purchaseOrder({ n: uniq(), rows: 10 }) });
  return { doc: body, pdf: (await download(body.download_url)).bytes };
}

test('verify: genuine PDF passes, a single flipped byte fails', async () => {
  const { doc, pdf } = await issue();
  const ok = await api('POST', '/v1/verify', pdf, { 'content-type': 'application/pdf' });
  assert.equal(ok.body.authentic, true);
  assert.equal(ok.body.doc_ref, doc.doc_ref);

  const forged = Buffer.from(pdf);
  forged[Math.floor(forged.length / 2)] ^= 0x01;
  const bad = await api('POST', '/v1/verify', forged, { 'content-type': 'application/pdf' });
  assert.equal(bad.body.authentic, false);
});

test('ledger rejects UPDATE and DELETE, and the hash chain verifies', async () => {
  await issue();
  const db = new pg.Client({ connectionString: 'postgres://pdf:pdf@localhost:55432/pdf' });
  await db.connect();
  await assert.rejects(db.query(`UPDATE pdf_ledger SET pdf_sha256 = 'x'`), /append-only/);
  await assert.rejects(db.query('DELETE FROM pdf_ledger'), /append-only/);
  await db.end();
  const chain = await api('GET', '/v1/ledger/verify');
  assert.equal(chain.body.ok, true);
});

test('object lock: archived PDF version cannot be deleted or silently replaced', async () => {
  const { doc } = await issue();
  const key = new URL(doc.download_url).pathname.replace(/^\/pdf-archive\//, '');
  const { Versions } = await s3.send(new ListObjectVersionsCommand({ Bucket: 'pdf-archive', Prefix: key }));
  const original = Versions[0].VersionId;
  await assert.rejects(s3.send(new DeleteObjectCommand({ Bucket: 'pdf-archive', Key: key, VersionId: original })), /AccessDenied/);
  // An overwrite only adds a newer version; the original bytes stay retrievable and locked.
  await s3.send(new PutObjectCommand({ Bucket: 'pdf-archive', Key: key, Body: 'tampered' }));
  const after = await s3.send(new ListObjectVersionsCommand({ Bucket: 'pdf-archive', Prefix: key }));
  assert.ok(after.Versions.some((v) => v.VersionId === original));
});
