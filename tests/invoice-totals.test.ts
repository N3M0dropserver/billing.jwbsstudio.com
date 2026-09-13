import { describe, it, expect } from 'vitest';
import {
  getInvoiceTotals,
  getExpenseTotals,
  taxYearRange,
  currentTaxYear,
  type TaxYearRange,
} from '~/lib/queries/dashboard';
import { isValidYearLabel } from '~/lib/queries/tax-position';
import { resolveRatesYear, hasRatesFor, NZ_YEARS, AU_YEARS } from '~/lib/tax/rates';
import type { Db } from '~/lib/db';

const $ = (d: number) => Math.round(d * 100);

const nzYear: TaxYearRange = {
  year: '2026-27',
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  jurisdiction: 'NZ',
  ratesYear: '2026-27',
  ratesAreProvisional: false,
};

/* ------------------------------------------------------------------ */
/* Invoice totals                                                      */
/* ------------------------------------------------------------------ */

interface InvoiceRow {
  status: string;
  dueOn: string;
  gstAmount: number;
  total: number;
  amountPaid: number;
  currency: 'NZD' | 'AUD';
  jurisdiction: 'NZ' | 'AU';
  fxRateToResidence: number;
}

function stubDb(rows: unknown[]): Db {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Db;
}

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    status: 'sent',
    dueOn: '2026-12-31',
    gstAmount: 0,
    total: $(1_000),
    amountPaid: 0,
    currency: 'NZD',
    jurisdiction: 'NZ',
    fxRateToResidence: 1,
    ...over,
  };
}

describe('getInvoiceTotals — currency', () => {
  it('does not add AUD cents to NZD cents', async () => {
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({ total: $(1_000), currency: 'NZD' }),
        invoice({ total: $(1_000), currency: 'AUD', jurisdiction: 'AU', fxRateToResidence: 1.09 }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );

    // A$1,000 at 1.09 is NZ$1,090 — not another NZ$1,000.
    expect(totals.invoicedTotal).toBe($(2_090));
  });

  it('leaves same-currency invoices untouched whatever rate is stored on them', async () => {
    // A stale or nonsense rate on a domestic invoice must not corrupt it.
    const totals = await getInvoiceTotals(
      stubDb([invoice({ total: $(1_000), currency: 'NZD', fxRateToResidence: 0.5 })]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.invoicedTotal).toBe($(1_000));
  });

  it('reports foreign-currency invoices left at a rate of 1 rather than trusting them', async () => {
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({ currency: 'AUD', jurisdiction: 'AU', fxRateToResidence: 1 }),
        invoice({ currency: 'AUD', jurisdiction: 'AU', fxRateToResidence: 1.09 }),
        invoice({ currency: 'NZD' }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.unconvertedForeignCurrencyCount).toBe(1);
  });

  it('keeps the pre-conversion figures per currency', async () => {
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({ total: $(1_000), currency: 'NZD' }),
        invoice({ total: $(2_000), currency: 'AUD', jurisdiction: 'AU', fxRateToResidence: 1.09 }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    const aud = totals.byCurrency.find((s) => s.currency === 'AUD');
    expect(aud?.invoiced).toBe($(2_000));
    // The residence currency sorts first, so the reader sees their own money first.
    expect(totals.byCurrency[0]?.currency).toBe('NZD');
  });

  it('converts the outstanding and overdue figures too, not just the headline', async () => {
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({
          total: $(1_000),
          amountPaid: $(400),
          currency: 'AUD',
          jurisdiction: 'AU',
          fxRateToResidence: 1.09,
          dueOn: '2020-01-01',
        }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.paidTotal).toBe($(436));
    expect(totals.unpaidTotal).toBe($(654));
    expect(totals.overdueTotal).toBe($(654));
  });
});

describe('getInvoiceTotals — source of supply', () => {
  it('splits by the jurisdiction of the invoice, not the residence of the user', async () => {
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({ total: $(1_000), gstAmount: $(130), jurisdiction: 'NZ' }),
        invoice({
          total: $(1_100),
          gstAmount: $(100),
          jurisdiction: 'AU',
          currency: 'AUD',
          fxRateToResidence: 1,
        }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );

    expect(totals.domestic.invoiced).toBe($(1_000));
    expect(totals.foreign.invoiced).toBe($(1_100));
    expect(totals.domestic.gstCollected).toBe($(130));
    expect(totals.foreign.gstCollected).toBe($(100));
    // The two halves must still account for the whole.
    expect(totals.domestic.invoiced + totals.foreign.invoiced).toBe(totals.invoicedTotal);
  });

  it('reads the same rows the other way round for an AU-resident user', async () => {
    const auYear: TaxYearRange = {
      year: '2026-27',
      startsOn: '2026-07-01',
      endsOn: '2027-06-30',
      jurisdiction: 'AU',
      ratesYear: '2026-27',
      ratesAreProvisional: false,
    };
    const totals = await getInvoiceTotals(
      stubDb([
        invoice({ total: $(1_000), jurisdiction: 'NZ', currency: 'NZD', fxRateToResidence: 0.92 }),
        invoice({ total: $(1_000), jurisdiction: 'AU', currency: 'AUD' }),
      ]),
      'u1',
      auYear,
      'AUD',
    );
    expect(totals.domestic.invoiced).toBe($(1_000));
    expect(totals.foreign.invoiced).toBe($(920));
  });

  it('excludes drafts from every figure that feeds tax', async () => {
    const totals = await getInvoiceTotals(
      stubDb([invoice({ status: 'draft', total: $(5_000) }), invoice({ total: $(1_000) })]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.invoicedTotal).toBe($(1_000));
    expect(totals.draftTotal).toBe($(5_000));
    expect(totals.byCurrency.reduce((n, s) => n + s.invoiceCount, 0)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Expense totals                                                      */
/* ------------------------------------------------------------------ */

describe('getExpenseTotals', () => {
  const expense = (over: Record<string, unknown> = {}) => ({
    category: 'software',
    amountGross: $(115),
    gstAmount: $(15),
    claimableAmount: $(100),
    businessUsePercent: 1,
    currency: 'NZD' as const,
    jurisdiction: 'NZ' as const,
    fxRateToResidence: 1,
    ...over,
  });

  it('converts foreign-currency spend before adding it', async () => {
    const totals = await getExpenseTotals(
      stubDb([
        expense({ claimableAmount: $(100) }),
        expense({
          claimableAmount: $(100),
          currency: 'AUD',
          jurisdiction: 'AU',
          fxRateToResidence: 1.09,
        }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.claimableTotal).toBe($(209));
  });

  it('keeps foreign GST out of the domestic reclaim', async () => {
    const totals = await getExpenseTotals(
      stubDb([
        expense({ gstAmount: $(15), jurisdiction: 'NZ' }),
        expense({ gstAmount: $(10), jurisdiction: 'AU', currency: 'AUD' }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    // GST paid to the ATO is not reclaimable on a NZ GST return.
    expect(totals.gstReclaimable).toBe($(15));
    expect(totals.foreignGstPaid).toBe($(10));
  });

  it('only reclaims the business-use share of GST', async () => {
    const totals = await getExpenseTotals(
      stubDb([expense({ gstAmount: $(15), businessUsePercent: 0.5 })]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.gstReclaimable).toBe($(7.5));
  });

  it('splits claimable spend by where it was incurred', async () => {
    const totals = await getExpenseTotals(
      stubDb([
        expense({ claimableAmount: $(300), jurisdiction: 'NZ' }),
        expense({ claimableAmount: $(200), jurisdiction: 'AU', currency: 'AUD' }),
      ]),
      'u1',
      nzYear,
      'NZD',
    );
    expect(totals.domesticClaimable).toBe($(300));
    expect(totals.foreignClaimable).toBe($(200));
    expect(totals.domesticClaimable + totals.foreignClaimable).toBe(totals.claimableTotal);
  });
});

/* ------------------------------------------------------------------ */
/* Rate table resolution                                               */
/* ------------------------------------------------------------------ */

describe('resolveRatesYear', () => {
  it('uses the exact table when there is one', () => {
    const latestNz = NZ_YEARS[NZ_YEARS.length - 1]!;
    const resolved = resolveRatesYear('NZ', latestNz);
    expect(resolved.ratesYear).toBe(latestNz);
    expect(resolved.provisional).toBe(false);
  });

  it('falls back to the most recent table rather than throwing', () => {
    // The failure this exists to stop: on 1 April the dashboard went from
    // working to 500 because no table had been added for the new year.
    const resolved = resolveRatesYear('NZ', '2099-00');
    expect(resolved.provisional).toBe(true);
    expect(resolved.ratesYear).toBe(NZ_YEARS[NZ_YEARS.length - 1]);
    expect(resolved.requestedYear).toBe('2099-00');
  });

  it('never silently reports a fallback as exact', () => {
    for (const year of ['2099-00', '1990-91']) {
      expect(resolveRatesYear('AU', year).provisional).toBe(true);
      expect(hasRatesFor('AU', year)).toBe(false);
    }
  });

  it('does not use a LATER year for an earlier one it lacks', () => {
    // Asking for a year before anything we hold must not apply future
    // brackets to a past return; it falls back to the earliest we have and
    // is still flagged provisional.
    const resolved = resolveRatesYear('AU', '1990-91');
    expect(resolved.ratesYear).toBe(AU_YEARS[0]);
    expect(resolved.provisional).toBe(true);
  });

  it('gives a year the right date range whether or not it has a table', () => {
    const future = taxYearRange('NZ', '2099-00');
    expect(future.startsOn).toBe('2099-04-01');
    expect(future.endsOn).toBe('2100-03-31');
    expect(future.year).toBe('2099-00');
    expect(future.ratesAreProvisional).toBe(true);

    const auFuture = taxYearRange('AU', '2099-00');
    expect(auFuture.startsOn).toBe('2099-07-01');
    expect(auFuture.endsOn).toBe('2100-06-30');
  });

  it('puts a date in the right year on both sides of the Tasman', () => {
    // 1 May 2026 is in the NZ year that began 1 April 2026, and still in the
    // AU year that began 1 July 2025.
    const may = new Date('2026-05-01T00:00:00Z');
    expect(currentTaxYear('NZ', may).year).toBe('2026-27');
    expect(currentTaxYear('AU', may).year).toBe('2025-26');
  });
});

describe('isValidYearLabel', () => {
  it('accepts a well-formed label', () => {
    expect(isValidYearLabel('2026-27')).toBe(true);
    expect(isValidYearLabel('1999-00')).toBe(true);
  });

  it('rejects what used to reach parseInt and produce NaN-04-01', () => {
    for (const bad of ['', 'x', '2026', '2026-2027', 'abc-de', '2026-29', '20x6-27', '../etc']) {
      expect(isValidYearLabel(bad)).toBe(false);
    }
  });
});
