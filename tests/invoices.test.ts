import { describe, it, expect } from 'vitest';
import {
  calculateLine,
  calculateInvoice,
  formatInvoiceNumber,
  dueDateFrom,
  deriveStatus,
} from '~/lib/invoices/calculate';

const $ = (d: number) => Math.round(d * 100);
const hours = (h: number) => Math.round(h * 1000);

describe('line calculation', () => {
  it('multiplies fractional hours exactly', () => {
    const line = calculateLine({ description: 'Design', quantity: hours(1.5), unitPrice: $(120) });
    expect(line.lineTotal).toBe($(180));
  });

  it('handles awkward fractions without float drift', () => {
    const line = calculateLine({ description: 'Design', quantity: hours(0.1), unitPrice: $(0.3) });
    expect(line.lineTotal).toBe(3);
  });

  it('applies a percentage discount', () => {
    const line = calculateLine({
      description: 'Brand', quantity: hours(10), unitPrice: $(100), discount: 0.15,
    });
    expect(line.lineTotal).toBe($(850));
  });

  it('treats a missing discount as zero', () => {
    const line = calculateLine({ description: 'x', quantity: hours(2), unitPrice: $(50) });
    expect(line.lineTotal).toBe($(100));
  });
});

describe('invoice totals', () => {
  const lines = [
    { description: 'Logo design', quantity: hours(10), unitPrice: $(120) },
    { description: 'Brand guidelines', quantity: hours(6), unitPrice: $(120) },
  ];

  it('adds 15% GST for a domestic NZ invoice', () => {
    const t = calculateInvoice(lines, {
      jurisdiction: 'NZ', year: '2026-27', treatment: 'standard',
    });
    expect(t.subtotal).toBe($(1_920));
    expect(t.gstAmount).toBe($(288));
    expect(t.total).toBe($(2_208));
  });

  it('charges no GST on a zero-rated export', () => {
    const t = calculateInvoice(lines, {
      jurisdiction: 'NZ', year: '2026-27', treatment: 'zero-rated-export',
    });
    expect(t.gstAmount).toBe(0);
    expect(t.total).toBe(t.subtotal);
    expect(t.gstLabel).toMatch(/zero-rated/i);
  });

  it('adds 10% GST for a domestic AU invoice', () => {
    const t = calculateInvoice(lines, {
      jurisdiction: 'AU', year: '2026-27', treatment: 'standard',
    });
    expect(t.gstAmount).toBe($(192));
  });

  it('excludes non-taxable lines from the GST base but not the subtotal', () => {
    const t = calculateInvoice(
      [
        { description: 'Design', quantity: hours(10), unitPrice: $(100) },
        { description: 'Disbursement', quantity: hours(1), unitPrice: $(500), taxable: false },
      ],
      { jurisdiction: 'NZ', year: '2026-27', treatment: 'standard' },
    );
    expect(t.subtotal).toBe($(1_500));
    expect(t.taxableBase).toBe($(1_000));
    expect(t.gstAmount).toBe($(150));
    expect(t.total).toBe($(1_650));
  });

  it('totals an empty invoice to zero rather than throwing', () => {
    const t = calculateInvoice([], { jurisdiction: 'NZ', year: '2026-27', treatment: 'standard' });
    expect(t.total).toBe(0);
  });
});

describe('invoice numbering and dates', () => {
  it('zero-pads so numbers sort lexically', () => {
    expect(formatInvoiceNumber('INV-', 7)).toBe('INV-0007');
    expect(formatInvoiceNumber('INV-', 1234)).toBe('INV-1234');
    expect(formatInvoiceNumber('INV-', 1).localeCompare(formatInvoiceNumber('INV-', 10))).toBeLessThan(0);
  });

  it('adds payment terms to the issue date', () => {
    expect(dueDateFrom('2026-09-12', 14)).toBe('2026-09-26');
  });

  it('rolls over a month boundary', () => {
    expect(dueDateFrom('2026-09-25', 14)).toBe('2026-10-09');
  });

  it('rolls over a year boundary', () => {
    expect(dueDateFrom('2026-12-28', 14)).toBe('2027-01-11');
  });
});

describe('status derivation', () => {
  const base = {
    status: 'sent' as const, total: $(1_000), amountPaid: 0,
    dueOn: '2026-12-01', sentAt: '2026-09-01T00:00:00Z', viewedAt: null,
  };

  it('marks a fully paid invoice paid', () => {
    expect(deriveStatus({ ...base, amountPaid: $(1_000) }, '2026-09-12')).toBe('paid');
  });

  it('marks an unpaid invoice past its due date overdue', () => {
    expect(deriveStatus({ ...base, dueOn: '2026-09-01' }, '2026-09-12')).toBe('overdue');
  });

  it('prefers paid over overdue when it was paid late', () => {
    expect(deriveStatus(
      { ...base, dueOn: '2026-09-01', amountPaid: $(1_000) }, '2026-09-12',
    )).toBe('paid');
  });

  it('marks a part payment partial', () => {
    expect(deriveStatus({ ...base, amountPaid: $(400) }, '2026-09-12')).toBe('partial');
  });

  it('marks a viewed but unpaid invoice viewed', () => {
    expect(deriveStatus({ ...base, viewedAt: '2026-09-02T00:00:00Z' }, '2026-09-12')).toBe('viewed');
  });

  it('never promotes a draft', () => {
    expect(deriveStatus({ ...base, status: 'draft', dueOn: '2020-01-01' }, '2026-09-12')).toBe('draft');
  });

  it('never overrides a terminal state', () => {
    expect(deriveStatus({ ...base, status: 'void', dueOn: '2020-01-01' }, '2026-09-12')).toBe('void');
    expect(deriveStatus({ ...base, status: 'written-off', amountPaid: $(1_000) }, '2026-09-12')).toBe('written-off');
  });

  it('does not call a zero-value invoice paid', () => {
    expect(deriveStatus({ ...base, total: 0, amountPaid: 0 }, '2026-09-12')).toBe('sent');
  });
});
