import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  detectColumns,
  parseSignedAmount,
  parseStatementDate,
  parseStatement,
} from '~/lib/bank/csv';

const $ = (d: number) => Math.round(d * 100);

describe('parseCsv', () => {
  it('handles quoted fields containing commas', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('handles doubled quotes as an escape', () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('a,"line one\nline two",c')).toEqual([['a', 'line one\nline two', 'c']]);
  });

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('strips a byte-order mark, which otherwise ruins the first header name', () => {
    const rows = parseCsv('﻿Date,Amount\n2026-01-01,5.00');
    expect(rows[0]).toEqual(['Date', 'Amount']);
  });

  it('drops blank lines rather than emitting empty rows', () => {
    expect(parseCsv('a,b\n\n\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('parseSignedAmount', () => {
  it('reads plain and signed amounts', () => {
    expect(parseSignedAmount('45.00')).toBe($(45));
    expect(parseSignedAmount('-45.00')).toBe(-$(45));
    expect(parseSignedAmount('1,234.56')).toBe($(1_234.56));
  });

  it('reads the other ways banks write a debit', () => {
    expect(parseSignedAmount('(45.00)')).toBe(-$(45));
    expect(parseSignedAmount('45.00 DR')).toBe(-$(45));
    expect(parseSignedAmount('45.00 CR')).toBe($(45));
  });

  it('refuses what it cannot read', () => {
    for (const bad of ['', ' ', 'n/a', 'balance']) {
      expect(parseSignedAmount(bad)).toBeNull();
    }
  });
});

describe('parseStatementDate', () => {
  it('reads the formats NZ and AU banks emit', () => {
    expect(parseStatementDate('2026-03-12')).toBe('2026-03-12');
    expect(parseStatementDate('12/03/2026')).toBe('2026-03-12');
    expect(parseStatementDate('12-03-26')).toBe('2026-03-12');
    expect(parseStatementDate('12 Mar 2026')).toBe('2026-03-12');
    expect(parseStatementDate('12-Mar-26')).toBe('2026-03-12');
  });

  it('reads ambiguous dates day-first', () => {
    // Every NZ and AU bank writes day-first, and this import is for those.
    expect(parseStatementDate('03/04/2026')).toBe('2026-04-03');
  });

  it('swaps when day-first is impossible', () => {
    expect(parseStatementDate('12/25/2025')).toBe('2025-12-25');
  });

  it('rejects impossible and unreadable dates', () => {
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('not a date')).toBeNull();
    expect(parseStatementDate('')).toBeNull();
  });
});

describe('detectColumns', () => {
  it('recognises an ANZ export', () => {
    const columns = detectColumns(
      ['Type', 'Details', 'Particulars', 'Code', 'Reference', 'Amount', 'Date'],
    );
    expect(columns?.date).toBe(6);
    expect(columns?.amount).toBe(5);
    expect(columns?.description).toContain(1);
    // Particulars and Code are where a NZ payer writes the invoice number.
    expect(columns?.reference).toEqual(expect.arrayContaining([2, 3, 4]));
  });

  it('recognises an ASB export', () => {
    const columns = detectColumns(
      ['Date', 'Unique Id', 'Tran Type', 'Cheque Number', 'Payee', 'Memo', 'Amount'],
    );
    expect(columns?.date).toBe(0);
    expect(columns?.amount).toBe(6);
    expect(columns?.description).toEqual(expect.arrayContaining([4, 5]));
  });

  it('recognises separate debit and credit columns', () => {
    const columns = detectColumns(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    expect(columns?.amount).toBeUndefined();
    expect(columns?.debit).toBe(2);
    expect(columns?.credit).toBe(3);
  });

  it('is case and separator insensitive', () => {
    expect(detectColumns(['TRANSACTION_DATE', 'transaction amount'])?.date).toBe(0);
  });

  it('returns null for a headerless export rather than eating a transaction', () => {
    expect(detectColumns(['12/03/2026', '-45.00', 'Countdown', '1234.00'])).toBeNull();
  });
});

describe('parseStatement', () => {
  it('reads a whole ANZ-shaped statement', () => {
    const csv = [
      'Type,Details,Particulars,Code,Reference,Amount,Date',
      'Transfer,Acme Design Ltd,INV-0042,,Invoice 42,1150.00,12/03/2026',
      'Eftpos,Countdown,Groceries,,,-84.20,13/03/2026',
    ].join('\n');

    const parsed = parseStatement(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-03-12',
      amount: $(1_150),
      description: 'Acme Design Ltd',
    });
    expect(parsed.rows[0]!.reference).toContain('INV-0042');
    expect(parsed.rows[1]!.amount).toBe(-$(84.2));
    expect(parsed.rejected).toHaveLength(0);
  });

  it('reads separate debit and credit columns', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '12/03/2026,Acme Design,,1150.00',
      '13/03/2026,Power bill,180.00,',
    ].join('\n');

    const parsed = parseStatement(csv);
    expect(parsed.rows[0]!.amount).toBe($(1_150));
    expect(parsed.rows[1]!.amount).toBe(-$(180));
  });

  it('names the lines it could not read instead of dropping them silently', () => {
    const csv = [
      'Date,Amount,Description',
      '12/03/2026,1150.00,Good row',
      'not a date,50.00,Bad date',
      '13/03/2026,,Missing amount',
    ].join('\n');

    const parsed = parseStatement(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.rejected[0]).toMatchObject({ line: 3, reason: 'No readable date.' });
    expect(parsed.rejected[1]).toMatchObject({ line: 4, reason: 'No readable amount.' });
  });

  it('explains itself when there is no usable header', () => {
    const parsed = parseStatement('12/03/2026,-45.00,Countdown');
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.warnings[0]).toMatch(/header row/i);
  });

  it('gives two genuinely identical transactions different fingerprints', () => {
    // Two $4.50 coffees on the same day are two transactions, not a
    // duplicate. De-duplicating them away would lose one.
    const csv = [
      'Date,Amount,Description',
      '12/03/2026,-4.50,Kokako Cafe',
      '12/03/2026,-4.50,Kokako Cafe',
    ].join('\n');

    const parsed = parseStatement(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!.fingerprint).not.toBe(parsed.rows[1]!.fingerprint);
  });

  it('produces the same fingerprints when the same period is imported twice', () => {
    // Which is what makes re-importing an overlapping export safe.
    const csv = [
      'Date,Amount,Description',
      '12/03/2026,1150.00,Acme',
      '13/03/2026,-84.20,Countdown',
    ].join('\n');

    const first = parseStatement(csv).rows.map((r) => r.fingerprint);
    const second = parseStatement(csv).rows.map((r) => r.fingerprint);
    expect(first).toEqual(second);
  });
});
