import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { chooseMode, mergeAndStamp, splitIntoChunks } from '../../src/render.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }));

test('documents above the threshold are routed to chunked mode', () => {
  assert.equal(chooseMode(5, 150), 'single_pass');
  assert.equal(chooseMode(150, 150), 'single_pass');
  assert.equal(chooseMode(151, 150), 'chunked');
});

test('chunked split covers every row once, in order, with header first and totals last', () => {
  const chunks = splitIntoChunks(rows(501), 'chunked', 150);
  assert.deepEqual(chunks.map((c) => c.rows.length), [150, 150, 150, 51]);
  assert.deepEqual(chunks.map((c) => c.start), [0, 150, 300, 450]);
  assert.deepEqual(chunks.map((c) => [c.isFirst, c.isLast]), [[true, false], [false, false], [false, false], [false, true]]);
  assert.deepEqual(chunks.flatMap((c) => c.rows).map((r) => r.i), rows(501).map((r) => r.i));
});

test('single pass and empty documents produce exactly one chunk', () => {
  assert.equal(splitIntoChunks(rows(400), 'single_pass', 150).length, 1);
  const [only] = splitIntoChunks([], 'chunked', 150);
  assert.ok(only.isFirst && only.isLast);
});

test('merge keeps every page from every chunk', async () => {
  const piece = async (pages) => {
    const d = await PDFDocument.create();
    for (let i = 0; i < pages; i++) d.addPage();
    return d.save();
  };
  const merged = await mergeAndStamp([await piece(2), await piece(3), await piece(1)], 'PO-1');
  assert.equal((await PDFDocument.load(merged)).getPageCount(), 6);
});
