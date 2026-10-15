import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { config } from './config.js';
import { db, sqs } from './clients.js';
import { BrowserPool } from './browser.js';
import { renderDocument } from './render.js';
import { sha256 } from './snapshot.js';
import { getObjectBuffer, putObject } from './storage.js';
import { appendLedger } from './ledger.js';
import { buildBulkDownloads } from './bulk.js';
import { enqueue } from './queue.js';

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// A 'rendering' row older than this is assumed to belong to a dead worker and may be re-claimed.
const STALE_RENDER_SEC = 120;

/**
 * Claim a document for rendering. SQS is at-least-once, so the same message can arrive twice or
 * after a worker died mid-render; the conditional UPDATE makes sure only one worker renders it.
 */
async function claim(documentId) {
  const { rows } = await db.query(
    `UPDATE documents SET status = 'rendering', attempts = attempts + 1, updated_at = now()
      WHERE id = $1
        AND (status = 'queued' OR (status = 'rendering' AND updated_at < now() - make_interval(secs => $2)))
      RETURNING *`,
    [documentId, STALE_RENDER_SEC],
  );
  return rows[0];
}

async function finishDocument(doc, fields) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE documents SET status = $3, error = $4, pdf_key = $5, pdf_sha256 = $6, pdf_bytes = $7,
              render_ms = $8, render_mode = $9, updated_at = now()
        WHERE id = $1 AND attempts = $2 AND status = 'rendering'`,
      [doc.id, doc.attempts, fields.status, fields.error ?? null, fields.pdfKey ?? null, fields.pdfSha ?? null,
        fields.bytes ?? null, fields.renderMs ?? null, fields.mode ?? doc.render_mode],
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return null; } // superseded by a newer claim
    if (fields.status === 'done') {
      await appendLedger(client, { documentId: doc.id, pdfSha256: fields.pdfSha, pdfKey: fields.pdfKey });
    }
    const { rows: [job] } = await client.query(
      `UPDATE jobs SET done = done + $2, failed = failed + $3, updated_at = now(),
              status = CASE WHEN kind = 'single' AND done + $2 + failed + $3 = total
                            THEN (CASE WHEN $2 = 1 THEN 'completed' ELSE 'failed' END)
                            ELSE status END
        WHERE id = $1 RETURNING *`,
      [doc.job_id, fields.status === 'done' ? 1 : 0, fields.status === 'failed' ? 1 : 0],
    );
    await client.query(`SELECT pg_notify('doc_finished', $1)`, [doc.id]); // delivered on COMMIT
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function finalizeBulkIfComplete(job) {
  if (job.kind !== 'bulk' || job.done + job.failed !== job.total) return;
  // Exactly one worker wins the transition running -> zipping.
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'zipping', updated_at = now() WHERE id = $1 AND status = 'running'`, [job.id]);
  if (rowCount === 0) return;
  const { rows: docs } = await db.query('SELECT * FROM documents WHERE job_id = $1 ORDER BY seq', [job.id]);
  const started = Date.now();
  if (job.done === 0) {
    await db.query(`UPDATE jobs SET status = 'failed', updated_at = now() WHERE id = $1`, [job.id]);
    return;
  }
  const { zipKey, partKeys, manifestKey } = await buildBulkDownloads(job, docs);
  await db.query(
    `UPDATE jobs SET status = 'completed', zip_key = $2, part_keys = $3, manifest_key = $4, updated_at = now()
      WHERE id = $1`,
    [job.id, zipKey, partKeys, manifestKey],
  );
  log('bulk zipped', { job_id: job.id, docs: job.done, failed: job.failed, ms: Date.now() - started });
}

/** Returns 'ack' (delete the message) or 'retry' (let SQS redeliver it). */
async function handle(pool, documentId) {
  const doc = await claim(documentId);
  if (!doc) {
    const { rows: [cur] } = await db.query('SELECT status FROM documents WHERE id = $1', [documentId]);
    // Done/failed/unknown: nothing to do. Still rendering elsewhere: leave the message for later.
    return !cur || cur.status === 'done' || cur.status === 'failed' ? 'ack' : 'retry';
  }
  if (doc.attempts > config.maxAttempts) {
    const job = await finishDocument(doc, { status: 'failed', error: doc.error ?? 'worker died while rendering' });
    if (job) await finalizeBulkIfComplete(job);
    return 'ack';
  }
  // Any retry (whether we caught the error or the previous worker died) uses the chunked path:
  // the most common reason a render fails is the renderer running out of memory on a big table.
  const mode = doc.attempts > 1 ? 'chunked' : doc.render_mode;

  const started = Date.now();
  try {
    const raw = await getObjectBuffer(config.s3.archiveBucket, doc.payload_key);
    if (sha256(raw) !== doc.payload_sha256) throw new Error('snapshot hash mismatch: payload altered after enqueue');
    const payload = JSON.parse(raw);
    const { rows: [job] } = await db.query('SELECT data_as_of FROM jobs WHERE id = $1', [doc.job_id]);
    const footer = `${doc.doc_ref}  ·  ERP data as of ${job.data_as_of.toISOString()}  ·  snapshot ${doc.payload_sha256.slice(0, 12)}`;

    const pdf = await renderDocument(pool, { docType: doc.doc_type, data: payload.data, mode, footer });
    const pdfSha = sha256(pdf);
    const issued = new Date();
    const pdfKey = `pdfs/${issued.getUTCFullYear()}/${String(issued.getUTCMonth() + 1).padStart(2, '0')}/${doc.job_id}/${doc.id}-a${doc.attempts}.pdf`;
    // Archive bucket has Object Lock (COMPLIANCE): once written, nobody (including root) can alter
    // or delete this object until retention expires.
    await putObject(config.s3.archiveBucket, pdfKey, pdf, 'application/pdf', { sha256: pdfSha, 'document-id': doc.id });
    const renderMs = Date.now() - started;
    const job2 = await finishDocument(doc, { status: 'done', pdfKey, pdfSha, bytes: pdf.length, renderMs, mode });
    log('rendered', { document_id: doc.id, doc_ref: doc.doc_ref, rows: doc.row_count, mode, ms: renderMs, bytes: pdf.length, attempt: doc.attempts });
    if (job2) await finalizeBulkIfComplete(job2);
    return 'ack';
  } catch (err) {
    log('render failed', { document_id: doc.id, mode, attempt: doc.attempts, error: err.message });
    if (doc.attempts < config.maxAttempts) {
      await db.query(
        `UPDATE documents SET status = 'queued', render_mode = 'chunked', error = $3, updated_at = now()
          WHERE id = $1 AND attempts = $2`,
        [doc.id, doc.attempts, err.message],
      );
      return 'retry';
    }
    const job = await finishDocument(doc, { status: 'failed', error: err.message, mode });
    if (job) await finalizeBulkIfComplete(job);
    return 'ack';
  }
}

/** Counting semaphore so both queue consumers share one render budget. */
class Slots {
  constructor(n) { this.free = n; this.waiters = []; }
  async take() {
    if (this.free > 0) { this.free--; return; }
    await new Promise((r) => this.waiters.push(r));
  }
  give() {
    const next = this.waiters.shift();
    if (next) next(); else this.free++;
  }
}

/**
 * Consume one queue. High priority (single docs, a user is waiting) may use every slot. Low
 * priority (bulk) leaves `reserve` slots idle so a burst of bulk work can't push a single request
 * past its 5-second budget.
 */
async function consume({ queueUrl, name, slots, reserve, pool, stopping }) {
  while (!stopping.value) {
    if (slots.free <= reserve) { await new Promise((r) => setTimeout(r, 100)); continue; }
    const max = Math.min(10, slots.free - reserve);
    let res;
    try {
      // Long polling: an idle worker makes ~3 requests/min per queue instead of thousands.
      res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: 20 }));
    } catch (err) {
      log('receive failed', { queue: name, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const msg of res.Messages ?? []) {
      await slots.take();
      (async () => {
        try {
          const { document_id: id } = JSON.parse(msg.Body);
          const outcome = await handle(pool, id);
          if (outcome === 'ack') {
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
          } else {
            // Make it visible again soon rather than after the full visibility timeout.
            await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle, VisibilityTimeout: 2 }));
          }
        } catch (err) {
          log('message handling crashed', { queue: name, error: err.message });
        } finally {
          slots.give();
        }
      })();
    }
  }
}

/**
 * Safety net, runs every minute on one worker at a time:
 *  - documents still 'queued' after 15 min whose SQS send may have been lost -> re-enqueue
 *  - bulk jobs stuck in 'zipping' (worker died mid-zip) -> retry the zip
 * Duplicate messages are harmless because claim() is conditional.
 */
async function sweep() {
  const client = await db.connect();
  try {
    const { rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock(7243002) AS locked');
    if (!locked) return;
    try {
      const { rows: lost } = await client.query(
        `SELECT d.id, j.kind FROM documents d JOIN jobs j ON j.id = d.job_id
          WHERE d.status = 'queued' AND d.updated_at < now() - interval '15 minutes' LIMIT 500`);
      for (const d of lost) {
        await enqueue(d.kind === 'single' ? config.sqs.highUrl : config.sqs.lowUrl, d.id);
        await client.query('UPDATE documents SET updated_at = now() WHERE id = $1', [d.id]);
      }
      const { rows: stuck } = await client.query(
        `UPDATE jobs SET status = 'running' WHERE status = 'zipping' AND updated_at < now() - interval '5 minutes' RETURNING *`);
      for (const job of stuck) await finalizeBulkIfComplete(job);
      if (lost.length || stuck.length) log('sweeper', { requeued: lost.length, rezipped: stuck.length });
    } finally {
      await client.query('SELECT pg_advisory_unlock(7243002)');
    }
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new BrowserPool();
  const slots = new Slots(config.workerConcurrency);
  const stopping = { value: false };
  const reserve = config.workerConcurrency > 1 ? 1 : 0;
  const sweeper = setInterval(() => sweep().catch((e) => log('sweeper failed', { error: e.message })), 60_000);

  const shutdown = async () => {
    log('shutting down: finishing in-flight renders');
    stopping.value = true;
    clearInterval(sweeper);
    while (slots.free < config.workerConcurrency) await new Promise((r) => setTimeout(r, 200));
    await pool.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown); // also what a Spot interruption notice turns into
  process.on('SIGINT', shutdown);

  log('worker started', { concurrency: config.workerConcurrency, chunk_rows: config.chunkRows });
  await Promise.all([
    consume({ queueUrl: config.sqs.highUrl, name: 'high', slots, reserve: 0, pool, stopping }),
    consume({ queueUrl: config.sqs.lowUrl, name: 'low', slots, reserve, pool, stopping }),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { handle, claim };
