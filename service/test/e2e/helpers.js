import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const API = process.env.API_URL ?? 'http://localhost:8080';
export const AUTH = { authorization: `Bearer ${process.env.SERVICE_TOKEN ?? 'local-dev-token'}` };
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export async function api(method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...AUTH, ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

export async function download(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

export async function waitForJob(jobId, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { body } = await api('GET', `/v1/jobs/${jobId}`);
    if (body.status === 'completed' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs} ms`);
}

// Text layer of a PDF via poppler's pdftotext (installed on the test host).
export function pdfText(bytes) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'x.pdf');
  fs.writeFileSync(f, bytes);
  return execFileSync('pdftotext', ['-layout', f, '-']).toString();
}

export const nowIso = () => new Date().toISOString();
export const uniq = () => Math.floor(Math.random() * 1e9);
