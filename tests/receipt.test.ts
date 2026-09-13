import { describe, it, expect } from 'vitest';
import {
  parseMoney,
  parseReceiptDate,
  normaliseReceipt,
  extractRawReceipt,
} from '~/lib/ai/receipt';

const $ = (d: number) => Math.round(d * 100);
const TODAY = new Date('2026-09-13T00:00:00Z');

describe('parseMoney', () => {
  it('reads the shapes a model actually returns', () => {
    expect(parseMoney('45.00')).toBe($(45));
    expect(parseMoney('$45')).toBe($(45));
    expect(parseMoney('NZ$1,234.56')).toBe($(1_234.56));
    expect(parseMoney('45.00 incl GST')).toBe($(45));
    expect(parseMoney(45.5)).toBe($(45.5));
  });

  it('reads a European decimal comma rather than silently dividing by a thousand', () => {
    // A receipt photographed on holiday. Reading 1.234,56 as 1.23 would be
    // wrong in a way nobody would notice.
    expect(parseMoney('1.234,56')).toBe($(1_234.56));
    expect(parseMoney('12,50')).toBe($(12.5));
  });

  it('refuses what it cannot read instead of guessing zero', () => {
    for (const bad of ['', 'unknown', 'N/A', null, undefined, {}, [], 'abc', '-45']) {
      expect(parseMoney(bad)).toBeNull();
    }
  });

  it('rejects an implausible total, which is what a misread decimal looks like', () => {
    expect(parseMoney('9999999.00')).toBeNull();
    expect(parseMoney('100000.01')).toBeNull();
    expect(parseMoney('100000.00')).toBe($(100_000));
  });
});

describe('parseReceiptDate', () => {
  it('takes ISO as given', () => {
    expect(parseReceiptDate('2026-03-12', TODAY)).toBe('2026-03-12');
  });

  it('reads an ambiguous date day-first, as NZ and AU write them', () => {
    expect(parseReceiptDate('03/04/2026', TODAY)).toBe('2026-04-03');
    expect(parseReceiptDate('3.4.2026', TODAY)).toBe('2026-04-03');
    expect(parseReceiptDate('03-04-26', TODAY)).toBe('2026-04-03');
  });

  it('swaps when only one order can be right', () => {
    // 2026-13-04 is impossible, so this is the 4th of December.
    expect(parseReceiptDate('12/25/2025', TODAY)).toBe('2025-12-25');
    expect(parseReceiptDate('25/12/2025', TODAY)).toBe('2025-12-25');
  });

  it('rejects a date that does not exist', () => {
    expect(parseReceiptDate('31/02/2026', TODAY)).toBeNull();
    expect(parseReceiptDate('2026-02-31', TODAY)).toBeNull();
  });

  it('rejects a receipt from the future, which means a misread', () => {
    expect(parseReceiptDate('2027-01-01', TODAY)).toBeNull();
  });

  it('rejects last century', () => {
    expect(parseReceiptDate('12/03/1998', TODAY)).toBeNull();
  });

  it('refuses junk', () => {
    for (const bad of ['', 'yesterday', 'unknown', null, 42]) {
      expect(parseReceiptDate(bad, TODAY)).toBeNull();
    }
  });
});

describe('normaliseReceipt', () => {
  it('reads a clean receipt', () => {
    const reading = normaliseReceipt(
      {
        vendor: 'Adobe Systems',
        date: '2026-08-01',
        total: '$92.00',
        gst: '12.00',
        currency: 'NZD',
        category: 'software',
        description: 'Creative Cloud monthly',
      },
      TODAY,
    );
    expect(reading).toMatchObject({
      vendor: 'Adobe Systems',
      incurredOn: '2026-08-01',
      amountGross: $(92),
      gstAmount: $(12),
      currency: 'NZD',
      category: 'software',
    });
    expect(reading.unreadable).toEqual([]);
  });

  it('drops a GST figure larger than half the total', () => {
    // Better to have the user tick the GST box than deduct the wrong amount.
    const reading = normaliseReceipt({ total: '100.00', gst: '90.00' }, TODAY);
    expect(reading.amountGross).toBe($(100));
    expect(reading.gstAmount).toBeNull();
    expect(reading.unreadable).toContain('gst');
  });

  it('drops GST when it could not read the total at all', () => {
    const reading = normaliseReceipt({ total: 'illegible', gst: '12.00' }, TODAY);
    expect(reading.amountGross).toBeNull();
    expect(reading.gstAmount).toBeNull();
  });

  it('names what it could not read rather than returning a guess', () => {
    const reading = normaliseReceipt(
      { vendor: 'unknown', date: 'sometime in March', total: 'smudged' },
      TODAY,
    );
    expect(reading.vendor).toBeNull();
    expect(reading.incurredOn).toBeNull();
    expect(reading.amountGross).toBeNull();
    expect(reading.unreadable).toEqual(['vendor', 'date', 'total']);
  });

  it('ignores a category it does not recognise', () => {
    expect(normaliseReceipt({ category: 'groceries' }, TODAY).category).toBeNull();
    expect(normaliseReceipt({ category: 'Home Office' }, TODAY).category).toBe('home-office');
    expect(normaliseReceipt({ category: 'phone_internet' }, TODAY).category).toBe('phone-internet');
  });

  it('only accepts a currency it can actually invoice in', () => {
    expect(normaliseReceipt({ currency: 'nzd' }, TODAY).currency).toBe('NZD');
    expect(normaliseReceipt({ currency: 'USD' }, TODAY).currency).toBeNull();
  });

  it('survives a model returning nothing useful', () => {
    const reading = normaliseReceipt({}, TODAY);
    expect(reading.amountGross).toBeNull();
    expect(reading.unreadable).toEqual([]);
  });

  it('collapses whitespace and caps length', () => {
    const reading = normaliseReceipt({ vendor: `  Adobe\n  Systems  ` }, TODAY);
    expect(reading.vendor).toBe('Adobe Systems');
    expect(normaliseReceipt({ vendor: 'x'.repeat(500) }, TODAY).vendor).toHaveLength(200);
  });
});

describe('extractRawReceipt', () => {
  it('finds JSON a model wrapped in prose and fences', () => {
    const text = 'Sure! Here is the receipt:\n```json\n{"vendor":"Mitre 10","total":"45.00"}\n```\nHope that helps.';
    expect(extractRawReceipt(text)).toEqual({ vendor: 'Mitre 10', total: '45.00' });
  });

  it('is not fooled by a brace inside a string', () => {
    const text = '{"vendor":"The } Cafe","total":"9.50"}';
    expect(extractRawReceipt(text)).toEqual({ vendor: 'The } Cafe', total: '9.50' });
  });

  it('returns null rather than throwing on malformed output', () => {
    expect(extractRawReceipt('no json here')).toBeNull();
    expect(extractRawReceipt('{"vendor": }')).toBeNull();
  });
});
