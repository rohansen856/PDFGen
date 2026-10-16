import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';
import { s3 } from './clients.js';
import { config } from './config.js';
import { getObjectStream } from './storage.js';

const fileName = (d) => `${String(d.seq + 1).padStart(3, '0')}_${d.doc_ref.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;

// Stream PDFs from the archive into a zip that streams into S3: memory stays flat no matter how big
// the batch is. STORE (no deflate) because PDFs are already compressed; deflating them burns CPU
// for ~1-3% savings.
async function writeZip(key, docs, manifest) {
  const archive = archiver('zip', { store: true });
  // archiver emits a userland `readable-stream`, which lib-storage doesn't recognise; a native
  // PassThrough bridges the two.
  const body = archive.pipe(new PassThrough());
  const upload = new Upload({
    client: s3,
    params: { Bucket: config.s3.downloadsBucket, Key: key, Body: body, ContentType: 'application/zip' },
  });
  const feed = (async () => {
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    for (const d of docs) {
      // One S3 stream open at a time: wait until archiver has written the previous entry.
      const written = once(archive, 'entry');
      archive.append(await getObjectStream(config.s3.archiveBucket, d.pdf_key), { name: fileName(d) });
      await written;
    }
    await archive.finalize();
  })();
  // Await both together so a failure on either side rejects here instead of escaping as an
  // unhandled rejection (which would take the whole worker process down).
  await Promise.all([upload.done(), feed]);
}

/**
 * Build the downloads for a finished bulk job:
 *   - one full zip (fast path for good connections; resumable via HTTP Range on the presigned URL)
 *   - parts of ZIP_PART_SIZE documents (for flaky connections: a drop costs one part, not the batch)
 *   - manifest.json listing every file's SHA-256 and every failure, so the client can verify what it
 *     received and see exactly which documents need a retry.
 */
export async function buildBulkDownloads(job, documents) {
  const ok = documents.filter((d) => d.status === 'done');
  const manifest = {
    job_id: job.id,
    data_as_of: job.data_as_of,
    snapshot_sha256: job.snapshot_sha256,
    generated_at: new Date().toISOString(),
    total: documents.length,
    files: ok.map((d) => ({ seq: d.seq, doc_ref: d.doc_ref, file: fileName(d), sha256: d.pdf_sha256, bytes: d.pdf_bytes })),
    failures: documents.filter((d) => d.status === 'failed').map((d) => ({ seq: d.seq, doc_ref: d.doc_ref, error: d.error })),
  };

  const prefix = `bulk/${job.id}`;
  await writeZip(`${prefix}/all.zip`, ok, manifest);
  const partKeys = [];
  for (let i = 0; i < ok.length; i += config.zipPartSize) {
    const key = `${prefix}/part-${partKeys.length + 1}.zip`;
    await writeZip(key, ok.slice(i, i + config.zipPartSize), manifest);
    partKeys.push(key);
  }
  const manifestKey = `${prefix}/manifest.json`;
  await new Upload({
    client: s3,
    params: { Bucket: config.s3.downloadsBucket, Key: manifestKey, Body: JSON.stringify(manifest, null, 2), ContentType: 'application/json' },
  }).done();
  return { zipKey: `${prefix}/all.zip`, partKeys, manifestKey };
}
