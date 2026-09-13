/**
 * Reading a bank statement export.
 *
 * Bank transfer is the default payment method on every invoice this app
 * sends, and marking those paid has been entirely manual — which is where the
 * daily minutes actually go. Every NZ and AU bank exports CSV, so that is the
 * import.
 *
 * There is no standard. ANZ writes `Type,Details,Particulars,Code,Reference,
 * Amount,Date`; ASB writes `Date,Unique Id,Tran Type,Cheque Number,Payee,
 * Memo,Amount`; CBA writes four unlabelled columns with no header row at all;
 * several Australian banks use separate Debit and Credit columns instead of
 * one signed Amount. So the columns are detected from a synonym table rather
 * than assumed, the detection is reported back to the user, and anything
 * unrecognised is named rather than silently dropped.
 *
 * All of this is pure: text in, rows out. No database, no clock.
 */

import type { Cents } from '~/lib/tax/money';

export interface BankRow {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Signed cents. Positive is money in. */
  amount: Cents;
  description: string;
  reference: string;
  /**
   * Stable identity for this row within this account, so re-importing an
   * overlapping statement does not create duplicates.
   */
  fingerprint: string;
}

export interface ColumnMap {
  date: number;
  /** One signed amount column. */
  amount?: number;
  /** Or a pair — several AU banks split them. */
  debit?: number;
  credit?: number;
  description: number[];
  reference: number[];
}

export interface ParsedStatement {
  rows: BankRow[];
  /** Header names, in order, as found. Empty when there was no header. */
  header: string[];
  columns: ColumnMap | null;
  /** Lines that could not be read, with the reason. */
  rejected: Array<{ line: number; reason: string; raw: string }>;
  /** Things worth telling the user that are not failures. */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Split CSV text into rows and fields.
 *
 * Handles quoted fields containing commas and newlines, doubled quotes as an
 * escape, and CRLF — all of which appear in real bank exports, usually in the
 * one transaction where somebody put a comma in a payment reference.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  // A byte-order mark survives export from more spreadsheet tools than you
  // would hope, and turns the first header name into something unrecognisable.
  const source = text.replace(/^﻿/, '');

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      inQuotes = true;
      started = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }

  // A trailing newline should not produce a phantom empty row.
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/* ------------------------------------------------------------------ */
/* Column detection                                                    */
/* ------------------------------------------------------------------ */

const DATE_NAMES = ['date', 'transaction date', 'processed date', 'value date', 'posting date'];
const AMOUNT_NAMES = ['amount', 'transaction amount', 'value'];
const DEBIT_NAMES = ['debit', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out'];
const CREDIT_NAMES = ['credit', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in'];
const DESCRIPTION_NAMES = [
  'description', 'details', 'payee', 'other party', 'narrative', 'memo',
  'transaction details', 'name',
];
/**
 * `particulars` and `code` belong here rather than with the description: in
 * New Zealand they are the fields the PAYER fills in, which is where an
 * invoice number actually arrives. The description is the counterparty.
 */
const REFERENCE_NAMES = [
  'reference', 'ref', 'code', 'particulars', 'analysis code', 'unique id', 'transaction id',
];

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

function findAll(header: string[], names: string[]): number[] {
  const found: number[] = [];
  header.forEach((cell, index) => {
    if (names.includes(normaliseHeader(cell))) found.push(index);
  });
  return found;
}

/**
 * Work out which column is which.
 *
 * Returns null when the row does not look like a header at all — which is how
 * a headerless export (CBA writes one) is recognised rather than having its
 * first transaction eaten as column names.
 */
export function detectColumns(header: string[]): ColumnMap | null {
  const date = findAll(header, DATE_NAMES)[0];
  if (date === undefined) return null;

  const amount = findAll(header, AMOUNT_NAMES)[0];
  const debit = findAll(header, DEBIT_NAMES)[0];
  const credit = findAll(header, CREDIT_NAMES)[0];

  if (amount === undefined && debit === undefined && credit === undefined) return null;

  return {
    date,
    amount,
    debit,
    credit,
    description: findAll(header, DESCRIPTION_NAMES),
    reference: findAll(header, REFERENCE_NAMES),
  };
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/**
 * A signed amount in cents.
 *
 * Banks write negatives as `-45.00`, `(45.00)` and occasionally `45.00 DR`.
 * All three mean money out.
 */
export function parseSignedAmount(value: string): Cents | null {
  const text = value.trim();
  if (!text) return null;

  const bracketed = /^\((.*)\)$/.exec(text);
  const debitSuffix = /\b(dr|db)\b/i.test(text);
  const creditSuffix = /\bcr\b/i.test(text);

  const body = bracketed ? bracketed[1]! : text;
  const cleaned = body.replace(/[^\d.,-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const negative = cleaned.trimStart().startsWith('-');
  const digits = cleaned.replace(/-/g, '');

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  const normalised =
    lastComma > lastDot
      ? digits.replace(/\./g, '').replace(',', '.')
      : digits.replace(/,/g, '');

  const parsed = Number.parseFloat(normalised);
  if (!Number.isFinite(parsed)) return null;

  const magnitude = Math.round(parsed * 100);
  const isNegative = negative || Boolean(bracketed) || (debitSuffix && !creditSuffix);
  return isNegative ? -magnitude : magnitude;
}

/**
 * A statement date.
 *
 * Day-first for an ambiguous value: every NZ and AU bank writes dates that
 * way, and this import is explicitly for those banks.
 */
export function parseStatementDate(value: string): string | null {
  const text = value.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const slashed = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})$/.exec(text);
  if (slashed) {
    let day = Number(slashed[1]);
    let month = Number(slashed[2]);
    let year = Number(slashed[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return buildDate(year, month, day);
  }

  // `12 Mar 2026` and `12-Mar-26`.
  const named = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/]*(\d{2,4})$/.exec(text);
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    let year = Number(named[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return buildDate(year, month, Number(named[1]));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (year < 1990 || year > 2999) return null;
  return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Statement                                                           */
/* ------------------------------------------------------------------ */

function join(cells: string[], indexes: number[]): string {
  return indexes
    .map((i) => cells[i]?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

/**
 * A stable identity for a transaction.
 *
 * Date, amount and text, plus how many identical rows preceded it in the same
 * statement — because two $4.50 coffees on the same day at the same cafe are
 * two transactions, not a duplicate, and de-duplicating them away would lose
 * one. Deterministic, so re-importing an overlapping period matches the rows
 * already held rather than doubling them.
 */
function fingerprintFor(row: Omit<BankRow, 'fingerprint'>, occurrence: number): string {
  const text = `${row.date}|${row.amount}|${row.description.toLowerCase()}|${row.reference.toLowerCase()}|${occurrence}`;
  // FNV-1a: short, stable, and no crypto import for something that only needs
  // to be collision-resistant within one person's bank account.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${row.date}-${hash.toString(36)}`;
}

export function parseStatement(text: string): ParsedStatement {
  const result: ParsedStatement = {
    rows: [],
    header: [],
    columns: null,
    rejected: [],
    warnings: [],
  };

  const table = parseCsv(text);
  if (table.length === 0) {
    result.warnings.push('That file had nothing in it.');
    return result;
  }

  const columns = detectColumns(table[0]!);
  if (!columns) {
    result.warnings.push(
      'Could not find a header row naming a date column and an amount column. ' +
        'Export with headers turned on, or add a first line such as "Date,Amount,Description,Reference".',
    );
    return result;
  }

  result.header = table[0]!.map((cell) => cell.trim());
  result.columns = columns;

  if (columns.description.length === 0) {
    result.warnings.push(
      'No description column was recognised, so matching will rely on the amount and date alone.',
    );
  }

  const seen = new Map<string, number>();

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const line = i + 1;
    const raw = cells.join(',').slice(0, 200);

    const date = parseStatementDate(cells[columns.date] ?? '');
    if (!date) {
      result.rejected.push({ line, reason: 'No readable date.', raw });
      continue;
    }

    let amount: Cents | null = null;
    if (columns.amount !== undefined) {
      amount = parseSignedAmount(cells[columns.amount] ?? '');
    } else {
      // Separate debit and credit columns: exactly one should be filled.
      const debit = columns.debit !== undefined ? parseSignedAmount(cells[columns.debit] ?? '') : null;
      const credit = columns.credit !== undefined ? parseSignedAmount(cells[columns.credit] ?? '') : null;
      if (credit !== null && credit !== 0) amount = Math.abs(credit);
      else if (debit !== null && debit !== 0) amount = -Math.abs(debit);
    }

    if (amount === null || amount === 0) {
      result.rejected.push({ line, reason: 'No readable amount.', raw });
      continue;
    }

    const partial = {
      date,
      amount,
      description: join(cells, columns.description),
      reference: join(cells, columns.reference),
    };

    const key = `${partial.date}|${partial.amount}|${partial.description}|${partial.reference}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    result.rows.push({ ...partial, fingerprint: fingerprintFor(partial, occurrence) });
  }

  if (result.rows.length === 0 && result.rejected.length > 0) {
    result.warnings.push(
      `Every one of the ${result.rejected.length} lines was unreadable. Check that the right columns were exported.`,
    );
  }

  return result;
}
