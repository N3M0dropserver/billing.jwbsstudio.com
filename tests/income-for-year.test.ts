import { describe, it, expect } from 'vitest';
import { getIncomeForYear, type TaxYearRange } from '~/lib/queries/dashboard';
import type { Db } from '~/lib/db';

const $ = (d: number) => Math.round(d * 100);

interface Row {
  kind: string;
  jurisdiction: 'NZ' | 'AU';
  taxYear: string;
  earnedFrom: string | null;
  earnedTo: string | null;
  grossAmount: number;
  taxWithheld: number;
  accLevyWithheld: number;
  currency: 'NZD' | 'AUD';
  fxRateToResidence: number;
}

/** The three calls getIncomeForYear makes, and nothing else. */
function stubDb(rows: Row[]): Db {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Db;
}

function row(over: Partial<Row> = {}): Row {
  return {
    kind: 'employment',
    jurisdiction: 'NZ',
    taxYear: '2026-27',
    earnedFrom: '2026-06-01',
    earnedTo: '2026-06-14',
    grossAmount: $(2_000),
    taxWithheld: $(400),
    accLevyWithheld: 0,
    currency: 'NZD',
    fxRateToResidence: 1,
    ...over,
  };
}

const nzYear: TaxYearRange = {
  year: '2026-27',
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  jurisdiction: 'NZ',
  ratesYear: '2026-27',
  ratesAreProvisional: false,
};

describe('getIncomeForYear', () => {
  it('keeps domestic employment separate from foreign', async () => {
    const totals = await getIncomeForYear(
      stubDb([
        row({ grossAmount: $(2_000) }),
        row({ jurisdiction: 'AU', currency: 'AUD', fxRateToResidence: 1.09, grossAmount: $(1_000), taxWithheld: $(150) }),
      ]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.domesticEmployment.grossIncome).toBe($(2_000));
    expect(totals.foreignEmployment.grossIncome).toBe($(1_090));
    expect(totals.foreignEmployment.taxWithheld).toBe($(163.5));
  });

  it('no longer drops foreign income on the floor', async () => {
    // This is the regression: an AU row used to be filtered out entirely for
    // an NZ-resident user, so the tax estimate simply omitted the income.
    const totals = await getIncomeForYear(
      stubDb([row({ jurisdiction: 'AU', currency: 'AUD', fxRateToResidence: 1.09 })]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.foreignEmployment.grossIncome).toBeGreaterThan(0);
  });

  it('converts before summing rather than adding AUD to NZD at par', async () => {
    const totals = await getIncomeForYear(
      stubDb([
        row({ jurisdiction: 'AU', currency: 'AUD', fxRateToResidence: 1.09, grossAmount: $(1_000), taxWithheld: 0 }),
      ]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.foreignEmployment.grossIncome).toBe($(1_090));
    expect(totals.foreignEmployment.grossInSourceCurrency).toBe($(1_000));
    expect(totals.convertedRowCount).toBe(1);
    expect(totals.unconvertedForeignCurrencyRowCount).toBe(0);
  });

  it('flags a foreign-currency row still sitting at a rate of 1', async () => {
    const totals = await getIncomeForYear(
      stubDb([row({ jurisdiction: 'AU', currency: 'AUD', fxRateToResidence: 1 })]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.unconvertedForeignCurrencyRowCount).toBe(1);
  });

  it('apportions a period that straddles 31 March and flags the split', async () => {
    const totals = await getIncomeForYear(
      stubDb([row({ earnedFrom: '2027-03-25', earnedTo: '2027-04-07', grossAmount: $(2_800), taxWithheld: $(560) })]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.domesticEmployment.grossIncome).toBe($(1_400));
    expect(totals.domesticEmployment.taxWithheld).toBe($(280));
    expect(totals.apportionedRowCount).toBe(1);
  });

  it('ignores a period that falls outside the year entirely', async () => {
    const totals = await getIncomeForYear(
      stubDb([row({ earnedFrom: '2027-06-01', earnedTo: '2027-06-14' })]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.domesticEmployment.grossIncome).toBe(0);
  });

  it('falls back to the whole labelled year for a row with no period', async () => {
    const totals = await getIncomeForYear(
      stubDb([row({ earnedFrom: null, earnedTo: null, taxYear: '2026-27', grossAmount: $(9_000) })]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.domesticEmployment.grossIncome).toBe($(9_000));
  });

  it('routes interest and dividends away from the employment figures', async () => {
    const totals = await getIncomeForYear(
      stubDb([
        row({ kind: 'interest', grossAmount: $(500), taxWithheld: $(165) }),
        row({ kind: 'dividends', jurisdiction: 'AU', currency: 'AUD', fxRateToResidence: 1.1, grossAmount: $(1_000), taxWithheld: 0 }),
      ]),
      'u',
      nzYear,
      'NZD',
    );
    expect(totals.domesticEmployment.grossIncome).toBe(0);
    expect(totals.domesticOther.grossIncome).toBe($(500));
    expect(totals.domesticOther.taxWithheld).toBe($(165));
    expect(totals.foreignOther.grossIncome).toBe($(1_100));
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
    const totals = await getIncomeForYear(
      stubDb([
        row({
          jurisdiction: 'NZ',
          currency: 'NZD',
          fxRateToResidence: 0.92,
          grossAmount: $(1_000),
          taxWithheld: 0,
          // Inside the AU year, which starts three months after the NZ one.
          earnedFrom: '2026-09-01',
          earnedTo: '2026-09-14',
        }),
      ]),
      'u',
      auYear,
      'AUD',
    );
    // An NZ row is the foreign one now.
    expect(totals.foreignEmployment.grossIncome).toBe($(920));
    expect(totals.domesticEmployment.grossIncome).toBe(0);
  });
});
