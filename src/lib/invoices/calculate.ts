/**
 * Invoice arithmetic.
 *
 * Quantities are stored in thousandths so "1.5 hours" is exact rather than
 * a float. Line totals are computed on the server and stored — an invoice is
 * a legal document and must not change value because a rounding rule was
 * altered two years later.
 */

import { type Cents, applyRate } from '~/lib/tax/money';
import { calculateGst, type GstTreatment } from '~/lib/tax/gst';
import type { Jurisdiction } from '~/lib/tax/rates';

export interface LineInput {
  description: string;
  /** Thousandths. 1500 == 1.5 */
  quantity: number;
  unitPrice: Cents;
  /** 0..1 */
  discount?: number;
  taxable?: boolean;
}

export interface CalculatedLine extends LineInput {
  lineTotal: Cents;
}

export interface InvoiceTotals {
  lines: CalculatedLine[];
  subtotal: Cents;
  /** Portion of the subtotal that GST actually applies to. */
  taxableBase: Cents;
  gstAmount: Cents;
  total: Cents;
  gstRate: number;
  gstLabel: string;
}

export function calculateLine(line: LineInput): CalculatedLine {
  const gross = Math.round((line.quantity / 1000) * line.unitPrice);
  const discounted = gross - applyRate(gross, line.discount ?? 0);
  return { ...line, lineTotal: discounted };
}

export function calculateInvoice(
  lines: LineInput[],
  options: { jurisdiction: Jurisdiction; year: string; treatment: GstTreatment },
): InvoiceTotals {
  const calculated = lines.map(calculateLine);

  const subtotal = calculated.reduce((sum, line) => sum + line.lineTotal, 0);
  const taxableBase = calculated
    .filter((line) => line.taxable !== false)
    .reduce((sum, line) => sum + line.lineTotal, 0);

  const gst = calculateGst(
    { net: taxableBase, treatment: options.treatment },
    options.jurisdiction,
    options.year,
  );

  return {
    lines: calculated,
    subtotal,
    taxableBase,
    gstAmount: gst.gst,
    total: subtotal + gst.gst,
    gstRate: gst.rate,
    gstLabel: gst.label,
  };
}

/** Next invoice number from a prefix and counter, zero-padded so they sort. */
export function formatInvoiceNumber(prefix: string, next: number): string {
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export function dueDateFrom(issuedOn: string, termsDays: number): string {
  const date = new Date(`${issuedOn}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}

export type InvoiceStatus =
  | 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'overdue' | 'void' | 'written-off';

/**
 * Derive the status a stored invoice should now have.
 *
 * Status is partly a function of time — an unpaid invoice becomes overdue on
 * its own — so it is recomputed on read rather than trusted from the column.
 * Terminal states are never overridden.
 */
export function deriveStatus(
  invoice: {
    status: InvoiceStatus;
    total: Cents;
    amountPaid: Cents;
    dueOn: string;
    sentAt: string | null;
    viewedAt: string | null;
  },
  today = new Date().toISOString().slice(0, 10),
): InvoiceStatus {
  if (invoice.status === 'void' || invoice.status === 'written-off') return invoice.status;
  if (invoice.status === 'draft') return 'draft';

  if (invoice.amountPaid >= invoice.total && invoice.total > 0) return 'paid';
  if (invoice.dueOn < today) return 'overdue';
  if (invoice.amountPaid > 0) return 'partial';
  if (invoice.viewedAt) return 'viewed';
  if (invoice.sentAt) return 'sent';
  return invoice.status;
}
