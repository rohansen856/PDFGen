// Synthetic ERP payloads, shaped like what the Django monolith would POST.
// Money is computed here (standing in for the ERP), never in the renderer.

const r2 = (n) => Math.round(n * 100) / 100;
const pick = (arr, i) => arr[i % arr.length];
const ITEMS = ['Mild steel sheet 2mm', 'Hex bolt M12 x 50 zinc plated', 'Industrial lubricant 20L drum',
  'PVC conduit pipe 25mm', 'Bearing 6205-2RS', 'Corrugated carton 5-ply', 'LED panel 18W', 'Copper wire 2.5 sq mm (90m)'];
const HSN = ['7208', '7318', '2710', '3917', '8482', '4819', '9405', '8544'];
const UNITS = ['NOS', 'KG', 'BOX', 'MTR'];

const company = { name: 'Shakti Fabricators Pvt Ltd', gstin: '27AABCS1234F1Z5', address: 'Plot 14, MIDC Bhosari, Pune 411026, Maharashtra' };
const vendor = { name: 'Ganesh Industrial Supplies', gstin: '27AAGFG5678K1Z2', address: 'Shop 7, Market Yard, Pune 411037, Maharashtra' };
const buyer = { name: 'Kaveri Engineering Works', gstin: '29AAKFK9012M1Z8', address: '3rd Cross, Peenya Industrial Area, Bengaluru 560058, Karnataka' };

export function purchaseOrder({ n = 1, rows = 10, version = '2026-10-18T09:00:00Z', fault } = {}) {
  const line_items = Array.from({ length: rows }, (_, i) => {
    const qty = (i % 17) + 1;
    const rate = r2(50 + ((i * 37) % 900) + 0.5);
    const tax_rate = pick([5, 12, 18, 28], i);
    return { sku: `SKU-${String(1000 + i)}`, description: pick(ITEMS, i), hsn: pick(HSN, i), qty, unit: pick(UNITS, i), rate, tax_rate, amount: r2(qty * rate) };
  });
  const subtotal = r2(line_items.reduce((s, l) => s + l.amount, 0));
  const tax = r2(line_items.reduce((s, l) => s + (l.amount * l.tax_rate) / 100, 0));
  const ref = `PO-2026-${String(n).padStart(5, '0')}`;
  return {
    doc_type: 'purchase_order',
    doc_ref: ref,
    source_version: version,
    data: {
      po_number: ref, po_date: '2026-10-18', delivery_date: '2026-11-01', currency: 'INR', company, vendor,
      line_items, totals: { subtotal, tax, grand_total: r2(subtotal + tax) }, notes: 'Deliver to Gate 2. Quote PO number on invoice.',
      ...(fault ? { _fault: fault } : {}),
    },
  };
}

export function invoice({ n = 1, rows = 8, version = '2026-10-18T09:00:00Z', unitRate } = {}) {
  const interState = true; // Maharashtra -> Karnataka: IGST
  const line_items = Array.from({ length: rows }, (_, i) => {
    const qty = (i % 9) + 1;
    const rate = unitRate ?? r2(120 + ((i * 53) % 700));
    const taxable = r2(qty * rate);
    const gst = r2(taxable * 0.18);
    return { description: pick(ITEMS, i), hsn: pick(HSN, i), qty, rate, taxable,
      cgst: interState ? 0 : r2(gst / 2), sgst: interState ? 0 : r2(gst / 2), igst: interState ? gst : 0, amount: r2(taxable + gst) };
  });
  const sum = (k) => r2(line_items.reduce((s, l) => s + l[k], 0));
  const ref = `INV/26-27/${String(n).padStart(5, '0')}`;
  return {
    doc_type: 'invoice',
    doc_ref: ref,
    source_version: version,
    data: {
      invoice_number: ref, invoice_date: '2026-10-18', place_of_supply: '29-Karnataka', reverse_charge: false,
      company, buyer, line_items,
      totals: { taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), grand_total: sum('amount'),
        amount_in_words: '(as supplied by ERP)' },
    },
  };
}
