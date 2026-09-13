/**
 * Coercion for the invoice editor's form payload.
 *
 * The editor posts its line items as a JSON blob in a hidden field, so it is
 * untrusted input like any other: every field is coerced and clamped here,
 * and the totals are recomputed server-side regardless of what the client
 * displayed.
 *
 * Shared by the create and edit routes so the two can never drift into
 * accepting different things.
 */

interface RawLine {
  description?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  taxable?: unknown;
}

export interface ParsedLine {
  description: string;
  /** Thousandths. 1500 == 1.5 */
  quantity: number;
  unit: string;
  unitPrice: number;
  taxable: boolean;
}

const UNITS = new Set(['hours', 'days', 'fixed', 'items']);

/** At most this many lines on one invoice, so a crafted payload cannot blow up a batch. */
const MAX_LINES = 100;
/** At most this many time entries claimed by one invoice. */
const MAX_IDS = 500;

export function parseLines(raw: string): ParsedLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.slice(0, MAX_LINES).map((entry: RawLine) => {
    const quantity = Number(entry.quantity);
    const unitPrice = Number(entry.unitPrice);
    const unit = String(entry.unit ?? 'hours');
    return {
      description: String(entry.description ?? '').slice(0, 500),
      quantity: Number.isFinite(quantity) ? Math.round(quantity) : 0,
      unit: UNITS.has(unit) ? unit : 'hours',
      unitPrice: Number.isFinite(unitPrice) ? Math.round(unitPrice) : 0,
      taxable: entry.taxable !== false,
    };
  });
}

export function parseIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string').slice(0, MAX_IDS)
      : [];
  } catch {
    return [];
  }
}
