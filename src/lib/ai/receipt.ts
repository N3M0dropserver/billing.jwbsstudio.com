/**
 * Reading a receipt.
 *
 * Expense capture fails at the moment of purchase, not at the form: the form
 * is thirty seconds and you are standing in a shop. Photographing the receipt
 * is two. So the picture goes in, a vision model reads it, and the form opens
 * already filled in for you to confirm.
 *
 * The confirming is the point. Nothing here writes an expense — it proposes
 * one. A model misreading $45.00 as $4,500 on a deductible expense is a
 * mistake with a tax consequence, so every field it returns is normalised,
 * range-checked and shown back before anything is saved, and the figures it
 * could not read come back empty rather than guessed.
 *
 * The normalising is pure and tested against the shapes models actually
 * return — `$1,234.56`, `12/03/2026`, `GST incl`, a bare number, prose — so
 * the part that can be wrong is the part under test.
 */

import { generateJson, MODELS, type AiResult } from '~/lib/ai';
import type { Cents } from '~/lib/tax/money';
import type { ExpenseCategory } from '~/lib/tax/deductions';

export const RECEIPT_CATEGORIES: ExpenseCategory[] = [
  'software',
  'hardware',
  'home-office',
  'vehicle',
  'travel',
  'meals-entertainment',
  'clothing',
  'education',
  'marketing',
  'subcontractors',
  'professional-fees',
  'insurance',
  'bank-fees',
  'phone-internet',
  'assets',
  'other',
];

/** What the model is asked for, before any normalising. */
export interface RawReceipt {
  vendor?: unknown;
  date?: unknown;
  total?: unknown;
  gst?: unknown;
  currency?: unknown;
  category?: unknown;
  description?: unknown;
}

/** What the form gets. Anything unreadable is null, never a guess. */
export interface ReceiptReading {
  vendor: string | null;
  /** ISO `YYYY-MM-DD`. */
  incurredOn: string | null;
  amountGross: Cents | null;
  gstAmount: Cents | null;
  currency: 'NZD' | 'AUD' | null;
  category: ExpenseCategory | null;
  description: string | null;
  /** Fields the model gave that could not be used, for showing the user. */
  unreadable: string[];
}

/** Upper bound on a single receipt, past which we assume a misread. */
const MAX_PLAUSIBLE = 100_000_00;

/**
 * Parse a money string into cents.
 *
 * Models return `$1,234.56`, `1234.56`, `NZ$45`, `45.00 incl GST`, and
 * occasionally a number. European-style `1.234,56` is handled too, because a
 * receipt photographed on holiday is a real case and reading it as €1.23
 * would be silently wrong rather than obviously wrong.
 */
export function parseMoney(value: unknown): Cents | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;
  if (cleaned.includes('-')) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let normalised: string;
  if (lastComma > lastDot) {
    // `1.234,56` — comma is the decimal separator.
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // `1,234.56` — commas are thousands separators.
    normalised = cleaned.replace(/,/g, '');
  }

  const parsed = Number.parseFloat(normalised);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  const cents = Math.round(parsed * 100);
  return cents > MAX_PLAUSIBLE ? null : cents;
}

/**
 * Parse a date into ISO.
 *
 * Day-first is assumed for an ambiguous `03/04/2026`, because this is a New
 * Zealand and Australian application and both write dates day-first. An
 * American receipt will occasionally be read a month out, which is why the
 * date is shown for confirmation rather than saved silently.
 */
export function parseReceiptDate(value: unknown, today = new Date()): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  let year: number;
  let month: number;
  let day: number;

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const slashed = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(text);
    if (!slashed) return null;
    day = Number(slashed[1]);
    month = Number(slashed[2]);
    year = Number(slashed[3]);
    if (year < 100) year += 2000;

    // A day over 12 in the first position settles it; otherwise day-first.
    if (day > 12 && month <= 12) {
      // Already day-first.
    } else if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }
  }

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const candidate = new Date(Date.UTC(year, month - 1, day));
  // Reject 31 February and friends: the Date constructor rolls them over.
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;

  // A receipt from the future, or from before this century, is a misread.
  const tomorrow = today.getTime() + 86_400_000;
  if (candidate.getTime() > tomorrow) return null;
  if (year < 2000) return null;

  return candidate.toISOString().slice(0, 10);
}

function parseCategory(value: unknown): ExpenseCategory | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (RECEIPT_CATEGORIES as string[]).includes(slug) ? (slug as ExpenseCategory) : null;
}

function parseText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || /^(unknown|n\/?a|none|null)$/i.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

/**
 * Turn whatever the model said into something the form can use.
 *
 * A GST figure larger than the total, or one that cannot be reconciled with
 * it, is dropped rather than carried through — it is better to have the user
 * tick the GST box themselves than to deduct the wrong amount.
 */
export function normaliseReceipt(raw: RawReceipt, today = new Date()): ReceiptReading {
  const unreadable: string[] = [];

  const vendor = parseText(raw.vendor, 200);
  if (raw.vendor && !vendor) unreadable.push('vendor');

  const incurredOn = parseReceiptDate(raw.date, today);
  if (raw.date && !incurredOn) unreadable.push('date');

  const amountGross = parseMoney(raw.total);
  if (raw.total && amountGross === null) unreadable.push('total');

  let gstAmount = parseMoney(raw.gst);
  if (raw.gst && gstAmount === null) unreadable.push('gst');

  // GST cannot exceed the total, and cannot be most of it.
  if (gstAmount !== null && amountGross !== null && gstAmount > Math.round(amountGross / 2)) {
    gstAmount = null;
    if (!unreadable.includes('gst')) unreadable.push('gst');
  }
  if (gstAmount !== null && amountGross === null) gstAmount = null;

  const currencyText = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  const currency = currencyText === 'AUD' ? 'AUD' : currencyText === 'NZD' ? 'NZD' : null;

  return {
    vendor,
    incurredOn,
    amountGross,
    gstAmount,
    currency,
    category: parseCategory(raw.category),
    description: parseText(raw.description, 200),
    unreadable,
  };
}

const SYSTEM = `You read receipts and invoices for a self-employed designer working in New Zealand and Australia.

Return ONLY a JSON object with these keys, and nothing else:
  vendor       the business that was paid, as printed
  date         the date of the purchase, ISO YYYY-MM-DD if you can
  total        the TOTAL amount paid, including any tax, as a plain number
  gst          the GST/tax component if the receipt states one, else null
  currency     "NZD" or "AUD" if you can tell, else null
  category     one of: ${RECEIPT_CATEGORIES.join(', ')}
  description  a short description of what was bought, at most 8 words

Rules you must follow:
- If a field is not legible or not present, use null. Never guess.
- "total" is the final amount charged, not a subtotal and not a single line.
- Do not invent a GST amount. Only report one the receipt actually states.
- Return the numbers only, without currency symbols or thousands separators.`;

export interface ReceiptImage {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Ask the model to read one receipt.
 *
 * Workers AI vision models take the image as an array of byte values rather
 * than base64 or a URL. The result is normalised before it leaves this
 * function, so no caller ever sees the model's raw output.
 */
export async function readReceipt(
  ai: Ai,
  image: ReceiptImage,
  today = new Date(),
): Promise<AiResult<ReceiptReading>> {
  try {
    const response = (await ai.run(MODELS.vision as Parameters<Ai['run']>[0], {
      image: [...image.bytes],
      prompt: SYSTEM,
      max_tokens: 512,
    } as never)) as { response?: string } | string;

    const text = typeof response === 'string' ? response : (response.response ?? '');
    if (!text.trim()) return { ok: false, error: 'The model could not read anything on that image.' };

    const parsed = extractRawReceipt(text);
    if (!parsed) {
      return { ok: false, error: 'The model did not return anything usable for that image.' };
    }

    return { ok: true, data: normaliseReceipt(parsed, today) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Exposed for the text-only fallback path and for tests. */
export function extractRawReceipt(text: string): RawReceipt | null {
  // Reuses the same balanced-JSON extraction the other AI helpers rely on.
  const start = text.search(/[{]/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as RawReceipt;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export { generateJson };
