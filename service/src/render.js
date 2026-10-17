import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from './config.js';

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const hb = Handlebars.create();
hb.registerPartial('styles', fs.readFileSync(path.join(templatesDir, '_styles.hbs'), 'utf8'));

// Display only. Money values arrive pre-computed from the ERP as strings/numbers in rupees; the
// renderer never does arithmetic on them, so a PDF can't disagree with the ledger it came from.
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
hb.registerHelper('money', (v) => (v === undefined || v === null || v === '' ? '' : `₹${inr.format(Number(v))}`));

const templates = Object.fromEntries(
  ['purchase_order', 'invoice'].map((t) => [t, hb.compile(fs.readFileSync(path.join(templatesDir, `${t}.hbs`), 'utf8'))]),
);

export function splitIntoChunks(rows, mode, chunkRows = config.chunkRows) {
  const size = mode === 'chunked' ? chunkRows : Math.max(rows.length, 1);
  const chunks = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += size) {
    chunks.push({ rows: rows.slice(i, i + size), start: i });
  }
  return chunks.map((c, idx) => ({ ...c, isFirst: idx === 0, isLast: idx === chunks.length - 1 }));
}

export function chooseMode(rowCount, chunkRows = config.chunkRows) {
  return rowCount > chunkRows ? 'chunked' : 'single_pass';
}

function chunkHtml(docType, data, chunk) {
  const template = templates[docType];
  if (!template) throw new Error(`unknown doc_type ${docType}`);
  return template({
    d: data,
    rows: chunk.rows.map((r, i) => ({ ...r, lineNo: chunk.start + i + 1 })),
    isFirst: chunk.isFirst,
    isLast: chunk.isLast,
    firstLineNo: chunk.start + 1,
  });
}

/**
 * Render one document to PDF bytes.
 * single_pass: whole document in one tab.
 * chunked:     CHUNK_ROWS line items per tab, each tab closed before the next opens, so peak
 *              renderer memory is bounded by chunk size instead of document size. Pieces are
 *              merged with pdf-lib and page numbers are stamped afterwards across the whole doc.
 */
export async function renderDocument(pool, { docType, data, mode, footer }) {
  const chunks = splitIntoChunks(data.line_items ?? [], mode);
  const pieces = [];
  for (const chunk of chunks) {
    const html = chunkHtml(docType, data, chunk);
    const pdf = await pool.withPage(async (page) => {
      if (config.allowFaultInjection && data._fault === 'crash_single_pass' && mode === 'single_pass') {
        // Really kill this tab's renderer process, which is exactly what a renderer OOM looks like.
        const cdp = await page.createCDPSession();
        await cdp.send('Page.crash').catch(() => {});
        await page.setContent('<p>unreachable</p>'); // throws: the target is gone
      }
      await page.setJavaScriptEnabled(false); // templates are static; no reason to run script
      await page.setContent(html, { waitUntil: 'load' });
      return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    });
    pieces.push(pdf);
  }
  return mergeAndStamp(pieces, footer);
}

export async function mergeAndStamp(pieces, footer) {
  const out = await PDFDocument.create();
  for (const bytes of pieces) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  const font = await out.embedFont(StandardFonts.Helvetica);
  const total = out.getPageCount();
  out.getPages().forEach((page, i) => {
    const text = `${footer}   ·   Page ${i + 1} of ${total}`;
    const size = 7;
    const { width } = page.getSize();
    page.drawText(text, {
      x: (width - font.widthOfTextAtSize(text, size)) / 2, y: 22, size, font, color: rgb(0.35, 0.35, 0.35),
    });
  });
  out.setProducer('pdfgen-service');
  out.setCreator('pdfgen-service');
  return Buffer.from(await out.save());
}
