// Measures what a render actually costs on this hardware, to replace the brief's "2-3 s / 400 MB"
// with real numbers. Run inside the worker image (it has Chromium):
//   docker compose run --rm --no-deps worker node scripts/loadtest.js
//
// Memory is Chromium's PSS (proportional set size: shared pages divided among the processes sharing
// them), summed over all Chromium processes and sampled every 25 ms. Summing RSS instead would
// double-count shared libraries and overstate memory by ~2x.
import fs from 'node:fs';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { BrowserPool } from '../src/browser.js';
import { renderDocument } from '../src/render.js';
import { config } from '../src/config.js';
import { purchaseOrder } from '../fixtures/generate.js';

function chromiumPssMb() {
  let kb = 0;
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('chrom')) continue;
      const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
      if (m) kb += Number(m[1]);
    } catch { /* process exited */ }
  }
  return kb / 1024;
}

async function measure(fn) {
  let peak = chromiumPssMb();
  const timer = setInterval(() => { peak = Math.max(peak, chromiumPssMb()); }, 25);
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  clearInterval(timer);
  return { ms: Math.round(ms), peakMb: Math.round(Math.max(peak, chromiumPssMb())), result };
}

const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const footer = 'LOADTEST';
const results = { host: { cpus: os.cpus().length, cpu: os.cpus()[0].model, totalMemMb: Math.round(os.totalmem() / 2 ** 20) } };

// 1. Cold: launch Chromium for every document (what a naive implementation does).
{
  const cold = [];
  for (let i = 0; i < 5; i++) {
    cold.push(await measure(async () => {
      const pool = new BrowserPool();
      const pdf = await renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows: 20 }).data, mode: 'single_pass', footer });
      await pool.close();
      return pdf.length;
    }));
  }
  results.cold_20_rows = { p50_ms: pct(cold.map((c) => c.ms), 50), max_ms: Math.max(...cold.map((c) => c.ms)), peak_pss_mb: Math.max(...cold.map((c) => c.peakMb)) };
}

// 2. Warm: one browser, fresh tab per document (what the worker does).
const pool = new BrowserPool();
await renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows: 5 }).data, mode: 'single_pass', footer }); // warm-up
{
  const idle = chromiumPssMb();
  const warm = [];
  for (let i = 0; i < 20; i++) {
    warm.push(await measure(() => renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows: 20 }).data, mode: 'single_pass', footer })));
  }
  results.warm_20_rows = {
    idle_browser_pss_mb: Math.round(idle),
    p50_ms: pct(warm.map((w) => w.ms), 50), p95_ms: pct(warm.map((w) => w.ms), 95),
    peak_pss_mb: Math.max(...warm.map((w) => w.peakMb)),
    pdf_kb: Math.round(warm[0].result.length / 1024),
  };
}

// 3. Throughput with N concurrent tabs on one browser.
results.throughput = [];
for (const conc of [1, 2, 4]) {
  const total = 24;
  let next = 0;
  const m = await measure(() => Promise.all(Array.from({ length: conc }, async () => {
    while (next < total) {
      next++;
      await renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows: 20 }).data, mode: 'single_pass', footer });
    }
  })));
  results.throughput.push({ concurrency: conc, docs: total, seconds: +(m.ms / 1000).toFixed(1), docs_per_min: Math.round((total / m.ms) * 60000), peak_pss_mb: m.peakMb });
}

// 4. Big documents: single pass vs chunked.
results.by_size = [];
for (const rows of [5, 50, 150, 500, 1000, 2000]) {
  for (const mode of rows > config.chunkRows ? ['single_pass', 'chunked'] : ['single_pass']) {
    await pool.close(); // fresh browser per case so peaks don't bleed into each other
    await renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows: 5 }).data, mode: 'single_pass', footer });
    const base = chromiumPssMb();
    try {
      const m = await measure(() => renderDocument(pool, { docType: 'purchase_order', data: purchaseOrder({ rows }).data, mode, footer }));
      const pages = (await PDFDocument.load(m.result)).getPageCount();
      results.by_size.push({ rows, mode, ms: m.ms, peak_pss_mb: m.peakMb, delta_over_idle_mb: Math.round(m.peakMb - base), pages, pdf_kb: Math.round(m.result.length / 1024) });
    } catch (err) {
      results.by_size.push({ rows, mode, error: err.message });
    }
  }
}
await pool.close();

console.log(JSON.stringify(results, null, 2));
