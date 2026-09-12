import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderInvoicePdf, type InvoicePdfData } from '~/lib/pdf/invoice';
import { PdfDocument, measureText, wrapText } from '~/lib/pdf/writer';

const sample: InvoicePdfData = {
  number: 'INV-0042',
  issuedOn: '2026-09-12',
  dueOn: '2026-09-26',
  currency: 'NZD',
  jurisdiction: 'NZ',
  gstTreatment: 'standard',
  gstLabel: 'GST 15%',
  reference: 'Rebrand phase 2',
  notes: 'Thanks — it was a pleasure working on this.',
  terms: 'Payment due within 14 days.',
  from: {
    businessName: 'JWBS Studio',
    legalName: 'JWBS Studio Limited',
    addressLines: ['12 Cuba Street', 'Te Aro, Wellington 6011'],
    email: 'hello@jwbsstudio.com',
    phone: '+64 21 555 0100',
    website: 'jwbsstudio.com',
    taxNumber: '123-456-789',
    taxNumberLabel: 'GST No.',
  },
  to: {
    name: 'Kōwhai Coffee Roasters',
    addressLines: ['88 Ponsonby Road', 'Grey Lynn, Auckland 1021'],
    email: 'accounts@kowhai.co.nz',
    taxNumber: '',
  },
  lines: [
    {
      description:
        'Brand identity — logo system, wordmark and supporting marks, including three rounds of revision',
      quantity: 24000, unit: 'hours', unitPrice: 12000, lineTotal: 288000,
    },
    { description: 'Brand guidelines document', quantity: 8000, unit: 'hours', unitPrice: 12000, lineTotal: 96000 },
    { description: 'Packaging artwork', quantity: 1000, unit: 'fixed', unitPrice: 150000, lineTotal: 150000 },
  ],
  subtotal: 534000,
  gstAmount: 80100,
  total: 614100,
  amountPaid: 0,
  bank: {
    accountName: 'JWBS Studio Limited',
    accountNumber: '12-3456-0789012-00',
    bankName: 'ASB',
    bsb: '',
    swift: 'ASBBNZ2A',
  },
  payUrl: 'https://billing.jwbsstudio.com/pay/abc123',
  footer: 'JWBS Studio · jwbsstudio.com',
};

const decode = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join('');

describe('PDF writer primitives', () => {
  it('measures text width proportionally', () => {
    expect(measureText('iiii', 10)).toBeLessThan(measureText('MMMM', 10));
  });

  it('scales width with font size', () => {
    expect(measureText('Hello', 20)).toBeCloseTo(measureText('Hello', 10) * 2, 5);
  });

  it('wraps text to a column width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 60, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureText(line, 10)).toBeLessThanOrEqual(60);
    }
  });

  it('preserves explicit newlines', () => {
    expect(wrapText('one\ntwo', 500, 10)).toEqual(['one', 'two']);
  });

  it('produces a structurally valid empty document', () => {
    const doc = new PdfDocument();
    doc.addPage().text('Hello', 50, 50);
    const text = decode(doc.build());
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

describe('invoice PDF', () => {
  const bytes = renderInvoicePdf(sample);
  const text = decode(bytes);

  it('emits a non-trivial file', () => {
    expect(bytes.length).toBeGreaterThan(2000);
  });

  it('has a valid header and trailer', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('declares an xref table whose startxref points at it', () => {
    const match = text.match(/startxref\n(\d+)\n%%EOF/);
    expect(match).not.toBeNull();
    const offset = Number.parseInt(match![1]!, 10);
    expect(text.slice(offset, offset + 4)).toBe('xref');
  });

  it('records byte offsets that land on real object headers', () => {
    const xrefStart = Number.parseInt(text.match(/startxref\n(\d+)\n%%EOF/)![1]!, 10);
    const xref = text.slice(xrefStart);
    const entries = [...xref.matchAll(/^(\d{10}) (\d{5}) n $/gm)];
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      const offset = Number.parseInt(entry[1]!, 10);
      expect(text.slice(offset)).toMatch(/^\d+ 0 obj/);
    }
  });

  it('contains the invoice number and client name', () => {
    expect(text).toContain('INV-0042');
    expect(text).toContain('Coffee Roasters');
  });

  it('labels a GST-registered invoice a tax invoice', () => {
    expect(text).toContain('TAX INVOICE');
  });

  it('labels an unregistered invoice a plain invoice', () => {
    const plain = decode(renderInvoicePdf({ ...sample, gstTreatment: 'not-registered', gstAmount: 0 }));
    expect(plain).toContain('INVOICE');
    expect(plain).not.toContain('TAX INVOICE');
  });

  it('states why no GST was charged on an export', () => {
    const exported = decode(
      renderInvoicePdf({ ...sample, gstTreatment: 'zero-rated-export', gstAmount: 0, gstLabel: 'Zero-rated export (0%)' }),
    );
    expect(exported).toContain('Zero-rated supply of services to a non-resident');
  });

  it('uses the Australian wording for an AU export', () => {
    const au = decode(
      renderInvoicePdf({ ...sample, jurisdiction: 'AU', currency: 'AUD', gstTreatment: 'zero-rated-export', gstAmount: 0, gstLabel: 'GST-free export' }),
    );
    expect(au).toContain('GST-free export of services');
  });

  it('shows an amount due net of part payment', () => {
    const partial = decode(renderInvoicePdf({ ...sample, amountPaid: 200000 }));
    expect(partial).toContain('Amount due');
    expect(partial).toContain('Paid');
  });

  it('escapes parentheses so they cannot break the content stream', () => {
    const tricky = renderInvoicePdf({
      ...sample,
      lines: [{ description: 'Work (phase 1) \\ extra', quantity: 1000, unit: 'fixed', unitPrice: 1000, lineTotal: 1000 }],
    });
    const out = decode(tricky);
    expect(out).toContain('Work \\(phase 1\\) \\\\ extra');
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('encodes Maori macrons rather than dropping them', () => {
    const out = decode(renderInvoicePdf({ ...sample, to: { ...sample.to, name: 'Kōwhai Tāmaki Makaurau' } }));
    // Macron vowels are emitted as octal escapes against the custom encoding.
    expect(out).toContain('K\\220whai T\\201maki');
    expect(out).toContain('/Differences');
    expect(out).toContain('/omacron');
  });

  it('strips accents it cannot encode rather than printing a question mark', () => {
    const out = decode(renderInvoicePdf({ ...sample, to: { ...sample.to, name: 'Zoë Crnčević' } }));
    expect(out).toContain('Crncevic');
  });

  it('survives non-Latin characters without corrupting the stream', () => {
    const macron = renderInvoicePdf({ ...sample, to: { ...sample.to, name: 'Kōwhai Tāmaki 日本' } });
    const out = decode(macron);
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
    const xrefStart = Number.parseInt(out.match(/startxref\n(\d+)\n%%EOF/)![1]!, 10);
    expect(out.slice(xrefStart, xrefStart + 4)).toBe('xref');
  });

  it('handles an invoice with no lines', () => {
    const empty = renderInvoicePdf({ ...sample, lines: [], subtotal: 0, gstAmount: 0, total: 0 });
    expect(decode(empty).trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('writes a sample to disk for eyeballing', () => {
    // Not an assertion — this is how you actually look at the output.
    const dir = 'tests/output';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/sample-invoice.pdf`, bytes);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
