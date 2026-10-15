import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { config } from './config.js';
import { db } from './clients.js';
import { canonicalJson, jobSnapshotHash, sha256 } from './snapshot.js';
import { putObject, presign } from './storage.js';
import { enqueue, enqueueMany } from './queue.js';
import { chooseMode } from './render.js';
import { verifyChain } from './ledger.js';

const DOC_TYPES = new Set(['purchase_order', 'invoice']);

function validateDocument(doc, i = 0) {
  const where = `documents[${i}]`;
  if (!doc || typeof doc !== 'object') return `${where} must be an object`;
  if (!DOC_TYPES.has(doc.doc_type)) return `${where}.doc_type must be one of ${[...DOC_TYPES].join(', ')}`;
  if (typeof doc.doc_ref !== 'string' || !doc.doc_ref) return `${where}.doc_ref is required`;
  if (typeof doc.source_version !== 'string' || !doc.source_version) return `${where}.source_version is required`;
  if (!doc.data || typeof doc.data !== 'object') return `${where}.data is required`;
  const rows = doc.data.line_items;
  if (!Array.isArray(rows)) return `${where}.data.line_items must be an array`;
  if (rows.length > config.maxRowsPerDoc) return `${where} has ${rows.length} line items (max ${config.maxRowsPerDoc})`;
  return null;
}

function validateAsOf(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : 'data_as_of must be an ISO-8601 timestamp';
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * Freeze the caller's data: every document payload is written to S3 (and hashed) *before* the job
 * exists. Workers render only from these frozen payloads and never read the ERP, so a document
 * rendered 3 minutes later shows exactly the data the user saw when they clicked "generate".
 */
async function createJob({ kind, dataAsOf, documents, idempotencyKey }) {
  const jobId = randomUUID();
  const docs = await Promise.all(documents.map(async (doc, seq) => {
    const body = canonicalJson(doc);
    const payloadSha = sha256(body);
    const payloadKey = `snapshots/${jobId}/${String(seq).padStart(3, '0')}.json`;
    await putObject(config.s3.archiveBucket, payloadKey, body, 'application/json', { sha256: payloadSha });
    return {
      id: randomUUID(), seq, doc, payloadKey, payloadSha,
      rowCount: doc.data.line_items.length,
      mode: chooseMode(doc.data.line_items.length),
    };
  }));
  const snapshotSha = jobSnapshotHash(dataAsOf, docs.map((d) => d.payloadSha));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO jobs (id, kind, idempotency_key, total, data_as_of, snapshot_sha256)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [jobId, kind, idempotencyKey, docs.length, dataAsOf, snapshotSha],
    );
    if (ins.rowCount === 0) { // lost a race with an identical request
      await client.query('ROLLBACK');
      return { jobId: await jobIdForKey(idempotencyKey), existing: true };
    }
    for (const d of docs) {
      await client.query(
        `INSERT INTO documents (id, job_id, seq, doc_type, doc_ref, source_version, row_count,
                                payload_key, payload_sha256, render_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [d.id, jobId, d.seq, d.doc.doc_type, d.doc.doc_ref, d.doc.source_version, d.rowCount,
          d.payloadKey, d.payloadSha, d.mode],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // If this send fails after commit, the worker-side sweeper re-enqueues stale 'queued' documents.
  const ids = docs.map((d) => d.id);
  if (kind === 'single') await enqueue(config.sqs.highUrl, ids[0]);
  else await enqueueMany(config.sqs.lowUrl, ids);
  return { jobId, documentIds: ids, existing: false };
}

async function jobIdForKey(key) {
  const { rows } = await db.query('SELECT id FROM jobs WHERE idempotency_key = $1', [key]);
  return rows[0]?.id;
}

async function documentView(d) {
  return {
    id: d.id,
    seq: d.seq,
    doc_type: d.doc_type,
    doc_ref: d.doc_ref,
    status: d.status,
    render_mode: d.render_mode,
    attempts: d.attempts,
    error: d.error ?? undefined,
    sha256: d.pdf_sha256 ?? undefined,
    bytes: d.pdf_bytes ?? undefined,
    render_ms: d.render_ms ?? undefined,
    download_url: d.status === 'done'
      ? await presign(config.s3.archiveBucket, d.pdf_key, `${safeName(d.doc_ref)}.pdf`)
      : undefined,
  };
}

async function jobView(jobId, { includeDocuments = true } = {}) {
  const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) return null;
  const view = {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    progress: { total: job.total, done: job.done, failed: job.failed,
      percent: Math.floor(((job.done + job.failed) / job.total) * 100) },
    data_as_of: job.data_as_of,
    snapshot_sha256: job.snapshot_sha256,
  };
  if (job.status === 'completed' && job.kind === 'bulk' && job.zip_key) {
    view.downloads = {
      zip_url: await presign(config.s3.downloadsBucket, job.zip_key, `pdfs-${job.id}.zip`),
      // Smaller zips for flaky connections: losing one part costs one part, not the whole batch.
      parts: await Promise.all((job.part_keys ?? []).map((k, i) =>
        presign(config.s3.downloadsBucket, k, `pdfs-${job.id}-part${i + 1}.zip`))),
      manifest_url: await presign(config.s3.downloadsBucket, job.manifest_key, 'manifest.json'),
      expires_in_seconds: config.downloadUrlTtlSec,
    };
  }
  if (includeDocuments) {
    const { rows } = await db.query('SELECT * FROM documents WHERE job_id = $1 ORDER BY seq', [jobId]);
    view.documents = await Promise.all(rows.map(documentView));
  }
  return view;
}

// One LISTEN connection per API process. Workers NOTIFY on completion, so a waiting single request
// wakes immediately instead of polling the shared ERP database every 100 ms.
class CompletionWaiter {
  constructor() { this.waiters = new Map(); }

  async start() {
    this.client = new pg.Client({ connectionString: config.databaseUrl });
    await this.client.connect();
    this.client.on('notification', (msg) => {
      const resolve = this.waiters.get(msg.payload);
      if (resolve) { this.waiters.delete(msg.payload); resolve(true); }
    });
    await this.client.query('LISTEN doc_finished');
  }

  wait(documentId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(documentId); resolve(false); }, timeoutMs);
      this.waiters.set(documentId, (v) => { clearTimeout(timer); resolve(v); });
    });
  }
}

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 25 * 1024 * 1024 });
  const waiter = new CompletionWaiter();
  await waiter.start();
  app.addHook('onClose', async () => { await waiter.client.end(); });

  app.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Service-to-service auth: only the Django monolith calls this API. End users reach PDFs through
  // Django (which checks their permissions) and then a short-lived presigned S3 URL.
  const expected = Buffer.from(`Bearer ${config.serviceToken}`);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/documents', async (req, reply) => {
    const { data_as_of: dataAsOf, document } = req.body ?? {};
    const err = validateAsOf(dataAsOf) ?? validateDocument(document);
    if (err) return reply.code(400).send({ error: err });

    // Same document at the same ERP version => same PDF. Retries and double-clicks reuse it.
    const key = `single:${sha256(`${document.doc_type}|${document.doc_ref}|${document.source_version}`)}`;
    let jobId = await jobIdForKey(key);
    if (!jobId) ({ jobId } = await createJob({ kind: 'single', dataAsOf, documents: [document], idempotencyKey: key }));

    const { rows: [doc] } = await db.query('SELECT id, status FROM documents WHERE job_id = $1', [jobId]);
    if (doc.status !== 'done' && doc.status !== 'failed') {
      // Re-check after subscribing so a NOTIFY that fired in between isn't missed.
      const waiting = waiter.wait(doc.id, config.singleWaitMs);
      const { rows: [again] } = await db.query('SELECT status FROM documents WHERE id = $1', [doc.id]);
      if (again.status !== 'done' && again.status !== 'failed') await waiting;
    }
    const view = await jobView(jobId);
    const d = view.documents[0];
    if (d.status === 'done') return reply.code(200).send({ job_id: jobId, ...d });
    if (d.status === 'failed') return reply.code(422).send({ job_id: jobId, ...d });
    // Not ready inside the wait budget (queue backlog at peak): hand back a job to poll.
    return reply.code(202).send({ job_id: jobId, status: d.status, status_url: `/v1/jobs/${jobId}` });
  });

  app.post('/v1/bulk', async (req, reply) => {
    const { data_as_of: dataAsOf, documents } = req.body ?? {};
    let err = validateAsOf(dataAsOf);
    if (!err && (!Array.isArray(documents) || documents.length === 0 || documents.length > config.maxBulkDocs)) {
      err = `documents must be an array of 1..${config.maxBulkDocs}`;
    }
    for (let i = 0; !err && i < documents.length; i++) err = validateDocument(documents[i], i);
    if (err) return reply.code(400).send({ error: err });

    const idemHeader = req.headers['idempotency-key'];
    const key = idemHeader ? `bulk:${idemHeader}` : null;
    let jobId = key ? await jobIdForKey(key) : null;
    if (!jobId) ({ jobId } = await createJob({ kind: 'bulk', dataAsOf, documents, idempotencyKey: key }));
    return reply.code(202).send({
      job_id: jobId,
      status_url: `/v1/jobs/${jobId}`,
      events_url: `/v1/jobs/${jobId}/events`,
    });
  });

  app.get('/v1/jobs/:id', async (req, reply) => {
    const view = await jobView(req.params.id);
    return view ? view : reply.code(404).send({ error: 'not found' });
  });

  // Server-sent events: progress pushed to the browser (via Django) without client polling logic.
  app.get('/v1/jobs/:id/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let last = '';
    let closed = false;
    req.raw.on('close', () => { closed = true; });
    while (!closed) {
      const view = await jobView(req.params.id, { includeDocuments: false });
      if (!view) { reply.raw.write('event: error\ndata: {"error":"not found"}\n\n'); break; }
      const payload = JSON.stringify(view);
      if (payload !== last) { reply.raw.write(`event: progress\ndata: ${payload}\n\n`); last = payload; }
      if (view.status === 'completed' || view.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    reply.raw.end();
  });

  // Upload a PDF; we tell you whether we issued exactly these bytes, and when.
  app.post('/v1/verify', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'send the PDF as the request body with Content-Type: application/pdf' });
    }
    const hash = sha256(req.body);
    const { rows: [hit] } = await db.query(
      `SELECT l.seq, l.issued_at, l.entry_hash, d.doc_ref, d.doc_type, d.job_id, d.payload_sha256
         FROM pdf_ledger l JOIN documents d ON d.id = l.document_id
        WHERE l.pdf_sha256 = $1 ORDER BY l.seq LIMIT 1`,
      [hash],
    );
    if (!hit) return { authentic: false, sha256: hash, reason: 'no PDF with this hash was ever issued' };
    return {
      authentic: true, sha256: hash, issued_at: hit.issued_at, doc_ref: hit.doc_ref, doc_type: hit.doc_type,
      job_id: hit.job_id, ledger_seq: Number(hit.seq), ledger_entry_hash: hit.entry_hash,
      rendered_from_snapshot_sha256: hit.payload_sha256,
    };
  });

  // Recompute the whole hash chain; detects edits made by anyone who bypassed the trigger.
  app.get('/v1/ledger/verify', async () => {
    const { rows } = await db.query('SELECT * FROM pdf_ledger ORDER BY seq');
    return verifyChain(rows);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
