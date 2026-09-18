import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DESIGN,
  LAYOUTS,
  PRESETS,
  luminance,
  mix,
  normalise,
  palette,
  parseDesign,
  readableInk,
  rgb,
  type InvoiceTemplateDesign,
} from '~/lib/pdf/template';
import { renderInvoicePdf, type InvoicePdfData } from '~/lib/pdf/invoice';
import { decodeImage } from '~/lib/pdf/image';

const base: InvoicePdfData = {
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
    businessName: 'Kōwhai Studio',
    legalName: 'Kōwhai Studio Limited',
    addressLines: ['12 Cuba Street', 'Te Aro, Wellington 6011'],
    email: 'hello@kowhai.studio',
    phone: '+64 21 555 0100',
    website: 'kowhai.studio',
    taxNumber: '123-456-789',
    taxNumberLabel: 'GST No.',
  },
  to: {
    name: 'Ponsonby Coffee Roasters',
    addressLines: ['88 Ponsonby Road', 'Grey Lynn, Auckland 1021'],
    email: 'accounts@ponsonbyroasters.co.nz',
    taxNumber: '',
  },
  lines: [
    {
      description: 'Brand identity — logo system, wordmark and supporting marks, with three rounds of revision',
      quantity: 24_000, unit: 'hours', unitPrice: 12_000, lineTotal: 288_000,
    },
    { description: 'Brand guidelines document', quantity: 8_000, unit: 'hours', unitPrice: 12_000, lineTotal: 96_000 },
    { description: 'Packaging artwork', quantity: 1_000, unit: 'fixed', unitPrice: 150_000, lineTotal: 150_000 },
  ],
  subtotal: 534_000,
  gstAmount: 80_100,
  total: 614_100,
  amountPaid: 0,
  bank: {
    accountName: 'Kōwhai Studio Limited',
    accountNumber: '12-3456-0789012-00',
    bankName: 'ASB',
    bsb: '',
    swift: 'ASBBNZ2A',
  },
  payUrl: 'https://billing.jwbsstudio.com/pay/abc123',
  footer: 'Kōwhai Studio · kowhai.studio',
};

const decode = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/** How many page objects the document ended up with. */
const pageCount = (bytes: Uint8Array) => [...decode(bytes).matchAll(/\/Type \/Page[^s]/g)].length;

const design = (over: Partial<InvoiceTemplateDesign> = {}) => normalise({ ...DEFAULT_DESIGN, ...over });

// ---------------------------------------------------------------------------

describe('colour parsing', () => {
  it('reads six-digit hex', () => {
    expect(rgb('#ffffff')).toEqual([1, 1, 1]);
    expect(rgb('#000000')).toEqual([0, 0, 0]);
  });

  it('expands shorthand and tolerates a missing hash', () => {
    expect(rgb('#fff')).toEqual(rgb('#ffffff'));
    expect(rgb('225c4d')).toEqual(rgb('#225c4d'));
  });

  it('falls back rather than throwing on nonsense', () => {
    // A template with one bad colour should render in the wrong shade, not
    // fail to produce the invoice someone is waiting to be paid for.
    expect(rgb('not a colour', [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
    expect(rgb('', [1, 0, 0])).toEqual([1, 0, 0]);
    expect(rgb('#12345', [0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('readable ink', () => {
  it('keeps a chosen colour that has enough contrast', () => {
    expect(readableInk([0, 0, 0], [1, 1, 1])).toEqual([1, 1, 1]);
  });

  it('overrides one that does not', () => {
    // White on pale yellow is the case this exists for: chosen, plausible in
    // a picker, and unreadable on paper.
    const ink = readableInk(rgb('#fff59d'), [1, 1, 1]);
    expect(luminance(ink)).toBeLessThan(0.3);
  });

  it('picks dark ink on a light ground and light on a dark one', () => {
    expect(luminance(readableInk([0.95, 0.95, 0.95]))).toBeLessThan(0.3);
    expect(luminance(readableInk([0.05, 0.05, 0.05]))).toBeGreaterThan(0.7);
  });
});

describe('mixing', () => {
  it('interpolates and clamps', () => {
    expect(mix([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(mix([0, 0, 0], [1, 1, 1], -3)).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [1, 1, 1], 9)).toEqual([1, 1, 1]);
  });

  it('gives the stripe a tint of the accent, not the accent', () => {
    const pal = palette({ ...DEFAULT_DESIGN.theme, background: '#ffffff', accent: '#000000' });
    expect(luminance(pal.stripe)).toBeGreaterThan(0.85);
    expect(luminance(pal.stripe)).toBeLessThan(1);
  });
});

describe('normalising a design', () => {
  it('fills in everything from nothing', () => {
    expect(normalise(undefined)).toEqual(DEFAULT_DESIGN);
    expect(normalise({})).toEqual(DEFAULT_DESIGN);
    expect(normalise('nonsense')).toEqual(DEFAULT_DESIGN);
    expect(normalise(42)).toEqual(DEFAULT_DESIGN);
  });

  it('rejects an unknown layout', () => {
    expect(normalise({ layout: 'spiral' }).layout).toBe(DEFAULT_DESIGN.layout);
    expect(normalise({ layout: 'sidebar' }).layout).toBe('sidebar');
  });

  it('clamps the type scale to what stays legible and still fits', () => {
    expect(normalise({ typeScale: 99 }).typeScale).toBe(1.25);
    expect(normalise({ typeScale: 0.1 }).typeScale).toBe(0.8);
    expect(normalise({ typeScale: 'big' }).typeScale).toBe(1);
  });

  it('clamps the logo size', () => {
    expect(normalise({ logo: { size: 5000 } }).logo.size).toBe(220);
    expect(normalise({ logo: { size: -4 } }).logo.size).toBe(24);
  });

  /**
   * The one that matters for security. The FILES bucket also holds every
   * invoice PDF ever issued, under `invoices/<user>/`. A design is
   * user-supplied JSON, so a key pointing anywhere else must not survive.
   */
  it('confines the logo key to the invoice-assets prefix', () => {
    expect(normalise({ logo: { key: 'invoice-assets/u1/logo.png' } }).logo.key).toBe(
      'invoice-assets/u1/logo.png',
    );
    expect(normalise({ logo: { key: 'invoices/someone-else/INV-1.pdf' } }).logo.key).toBe('');
    expect(normalise({ logo: { key: '../invoices/x.pdf' } }).logo.key).toBe('');
    expect(normalise({ logo: { key: 42 } }).logo.key).toBe('');
  });

  it('keeps a valid colour and discards an invalid one', () => {
    const result = normalise({ theme: { accent: '#123456', text: 'javascript:alert(1)' } });
    expect(result.theme.accent).toBe('#123456');
    expect(result.theme.text).toBe(DEFAULT_DESIGN.theme.text);
  });

  it('adds the missing hash so the value is usable in a colour input', () => {
    expect(normalise({ theme: { accent: '225c4d' } }).theme.accent).toBe('#225c4d');
  });

  it('only accepts real booleans for the switches', () => {
    expect(normalise({ options: { showBankDetails: false } }).options.showBankDetails).toBe(false);
    expect(normalise({ options: { showBankDetails: 'no' } }).options.showBankDetails).toBe(true);
  });

  it('is idempotent', () => {
    const once = normalise(PRESETS[2]!.design);
    expect(normalise(once)).toEqual(once);
  });
});

describe('parsing a stored design', () => {
  it('reads back what was written', () => {
    expect(parseDesign(JSON.stringify(PRESETS[1]!.design))).toEqual(normalise(PRESETS[1]!.design));
  });

  it('falls back on a corrupt column rather than failing the invoice', () => {
    expect(parseDesign('{not json')).toEqual(DEFAULT_DESIGN);
    expect(parseDesign('')).toEqual(DEFAULT_DESIGN);
  });
});

describe('the presets', () => {
  it('covers every layout', () => {
    expect(new Set(PRESETS.map((p) => p.design.layout))).toEqual(new Set(LAYOUTS));
  });

  it('has unique ids and names', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });

  it('survives normalisation unchanged — none of them is subtly invalid', () => {
    for (const preset of PRESETS) {
      expect({ id: preset.id, design: normalise(preset.design) }).toEqual({
        id: preset.id,
        design: preset.design,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe('every layout produces a usable invoice', () => {
  it.each(LAYOUTS)('%s renders a structurally valid PDF', (layout) => {
    const bytes = renderInvoicePdf(base, { design: design({ layout }) });
    const text = decode(bytes);

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    const xrefStart = Number.parseInt(text.match(/startxref\n(\d+)\n%%EOF/)![1]!, 10);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
  });

  it.each(LAYOUTS)('%s carries the number, the client and the total', (layout) => {
    const text = decode(renderInvoicePdf(base, { design: design({ layout }) }));
    expect(text).toContain('INV-0042');
    expect(text).toContain('Coffee Roasters');
    expect(text).toContain('6,141.00');
  });

  /**
   * The tax wording is not a design decision. No template, and no combination
   * of switches, may turn it off — which is exactly the kind of thing a
   * "make it configurable" feature quietly breaks.
   */
  it.each(LAYOUTS)('%s says "TAX INVOICE" when GST is charged', (layout) => {
    expect(decode(renderInvoicePdf(base, { design: design({ layout }) }))).toContain('TAX INVOICE');
  });

  it.each(LAYOUTS)('%s does not say "tax invoice" when not registered', (layout) => {
    const text = decode(
      renderInvoicePdf({ ...base, gstTreatment: 'not-registered', gstAmount: 0 }, { design: design({ layout }) }),
    );
    expect(text).toContain('INVOICE');
    expect(text).not.toContain('TAX INVOICE');
  });

  it.each(LAYOUTS)('%s states why no GST was charged on an export', (layout) => {
    const text = decode(
      renderInvoicePdf(
        { ...base, gstTreatment: 'zero-rated-export', gstAmount: 0, gstLabel: 'Zero-rated export (0%)' },
        { design: design({ layout }) },
      ),
    );
    expect(text).toContain('Zero-rated supply of services to a non-resident');
  });

  it.each(LAYOUTS)('%s handles an invoice with no lines', (layout) => {
    const empty = { ...base, lines: [], subtotal: 0, gstAmount: 0, total: 0 };
    expect(decode(renderInvoicePdf(empty, { design: design({ layout }) })).trimEnd()).toMatch(/%%EOF$/);
  });

  it.each(LAYOUTS)('%s shows the amount due net of a part payment', (layout) => {
    const text = decode(renderInvoicePdf({ ...base, amountPaid: 200_000 }, { design: design({ layout }) }));
    expect(text).toContain('Amount due');
    expect(text).toContain('Paid');
  });
});

describe('the switches actually switch something', () => {
  it('drops the bank block when asked', () => {
    const on = decode(renderInvoicePdf(base, { design: design() }));
    const off = decode(
      renderInvoicePdf(base, { design: design({ options: { ...DEFAULT_DESIGN.options, showBankDetails: false } }) }),
    );
    expect(on).toContain('ASBBNZ2A');
    expect(off).not.toContain('ASBBNZ2A');
  });

  it('drops the pay link when asked', () => {
    const off = decode(
      renderInvoicePdf(base, { design: design({ options: { ...DEFAULT_DESIGN.options, showPayLink: false } }) }),
    );
    expect(off).not.toContain('/pay/abc123');
  });

  it('changes the file when the accent colour changes', () => {
    const green = decode(renderInvoicePdf(base, { design: design() }));
    const red = decode(
      renderInvoicePdf(base, { design: design({ theme: { ...DEFAULT_DESIGN.theme, accent: '#aa0000' } }) }),
    );
    expect(red).not.toBe(green);
    // #aa0000 is 170/255 on the red channel, written unrounded.
    expect(red).toMatch(/0\.6666666666666666 0 0 rg/);
    expect(green).not.toMatch(/0\.6666666666666666 0 0 rg/);
  });

  it('paints a background only when it is not white', () => {
    const white = decode(renderInvoicePdf(base, { design: design() }));
    const cream = decode(
      renderInvoicePdf(base, { design: design({ theme: { ...DEFAULT_DESIGN.theme, background: '#faf6ee' } }) }),
    );
    // A full-page rectangle at the origin is the background fill.
    expect(cream).toMatch(/0\.00 0\.00 595\.28 841\.89 re/);
    expect(white).not.toMatch(/0\.00 0\.00 595\.28 841\.89 re/);
  });
});

describe('pagination', () => {
  const many = {
    ...base,
    lines: Array.from({ length: 40 }, (_, i) => ({
      description: `Line ${i + 1} — long enough to wrap onto a second line in the description column`,
      quantity: 1_000, unit: 'fixed', unitPrice: 12_500, lineTotal: 12_500,
    })),
    subtotal: 500_000, gstAmount: 75_000, total: 575_000,
  };

  it.each(LAYOUTS)('%s breaks a long invoice onto more pages', (layout) => {
    const short = renderInvoicePdf(base, { design: design({ layout }) });
    const long = renderInvoicePdf(many, { design: design({ layout }) });

    expect(pageCount(short)).toBe(1);
    expect(pageCount(long)).toBeGreaterThan(1);
  });

  it.each(LAYOUTS)('%s still reaches the totals on a long invoice', (layout) => {
    // The failure this guards: before pagination, the lines and the totals
    // were drawn straight off the bottom of the page and nothing said so.
    expect(decode(renderInvoicePdf(many, { design: design({ layout }) }))).toContain('Amount due');
  });

  it('repeats the column headings on each page', () => {
    const text = decode(renderInvoicePdf(many, { design: design() }));
    expect([...text.matchAll(/\(DESCRIPTION\) Tj/g)].length).toBeGreaterThan(1);
  });
});

describe('a logo on the page', () => {
  /** A 4×4 opaque PNG is enough — placement is what is under test. */
  const logo = async () => {
    const { deflate } = await import('~/lib/pdf/image');
    const width = 4;
    const height = 4;
    const raw = new Uint8Array((width * 3 + 1) * height);
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 2;

    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    const crc = (bytes: Uint8Array) => {
      let value = 0xffffffff;
      for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
      return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, body.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(body, 8);
      dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
      return out;
    };

    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', await deflate(raw)),
      chunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return decodeImage(out);
  };

  /** The x translation of each image placement. */
  const placements = (bytes: Uint8Array) =>
    [...decode(bytes).matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im0 Do/g)].map((m) =>
      Number.parseFloat(m[3]!),
    );

  it.each(LAYOUTS)('%s places the logo when there is one', async (layout) => {
    const image = await logo();
    const without = decode(renderInvoicePdf(base, { design: design({ layout }) }));
    const withLogo = decode(
      renderInvoicePdf(base, {
        design: design({ layout, logo: { key: 'invoice-assets/u/logo.png', size: 90, position: 'left' } }),
        logo: image,
      }),
    );

    expect(without).not.toContain('/Im0 Do');
    expect(withLogo).toContain('/Im0 Do');
  });

  it.each(LAYOUTS)('%s honours the logo position', async (layout) => {
    const image = await logo();
    const at = (position: 'left' | 'centre' | 'right') =>
      placements(
        renderInvoicePdf(base, {
          design: design({ layout, logo: { key: 'invoice-assets/u/logo.png', size: 80, position } }),
          logo: image,
        }),
      )[0]!;

    // Asserted as one value so a failure names the layout and the order.
    expect({ layout, ordered: at('left') < at('centre') && at('centre') < at('right') }).toEqual({
      layout,
      ordered: true,
    });
  });

  it('renders without a logo when the design names one but none was loaded', () => {
    // What happens when R2 is unreachable: an invoice with no logo, not a
    // failed send. `loadLogo` returns null and the renderer carries on.
    const text = decode(
      renderInvoicePdf(base, {
        design: design({ logo: { key: 'invoice-assets/u/gone.png', size: 90, position: 'left' } }),
        logo: null,
      }),
    );
    expect(text).not.toContain('/Im0 Do');
    expect(text).toContain('INV-0042');
  });
});

describe('an unknown layout still produces an invoice', () => {
  it('falls back rather than throwing', () => {
    // `normalise` would catch this, so it is reached only by a design that
    // bypassed it — which is precisely when failing would be worst.
    const text = decode(
      renderInvoicePdf(base, { design: { ...DEFAULT_DESIGN, layout: 'nonsense' as never } }),
    );
    expect(text).toContain('INV-0042');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});
