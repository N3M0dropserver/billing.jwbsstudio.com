import { describe, it, expect } from 'vitest';
import {
  apportion,
  auYearRange,
  daysInclusive,
  nzYearRange,
  overlapDays,
  straddles,
  toResidenceCurrency,
} from '~/lib/tax/period';
import { calculateCombined } from '~/lib/tax/engine';

const $ = (d: number) => Math.round(d * 100);

describe('day counting', () => {
  it('counts a single day as one, not zero', () => {
    expect(daysInclusive({ startsOn: '2026-04-01', endsOn: '2026-04-01' })).toBe(1);
  });

  it('counts a full NZ tax year', () => {
    // 2026-27 is not a leap year at either end: 365 days.
    expect(daysInclusive(nzYearRange('2026-27'))).toBe(365);
  });

  it('counts a full AU financial year', () => {
    expect(daysInclusive(auYearRange('2026-27'))).toBe(365);
  });

  it('spans a leap day without losing it', () => {
    // The NZ 2027-28 year contains 29 February 2028.
    expect(daysInclusive(nzYearRange('2027-28'))).toBe(366);
  });

  it('returns zero when the range runs backwards', () => {
    expect(daysInclusive({ startsOn: '2026-04-10', endsOn: '2026-04-01' })).toBe(0);
  });

  it('finds no overlap between ranges that never meet', () => {
    expect(
      overlapDays(
        { startsOn: '2026-01-01', endsOn: '2026-01-31' },
        { startsOn: '2026-04-01', endsOn: '2027-03-31' },
      ),
    ).toBe(0);
  });
});

describe('apportioning a period across a tax year boundary', () => {
  const nz2026 = nzYearRange('2026-27'); // 1 Apr 2026 – 31 Mar 2027

  it('gives the whole amount to a period sitting inside the year, with no rounding', () => {
    const earned = { startsOn: '2026-06-01', endsOn: '2026-06-14' };
    expect(apportion($(1_234.57), earned, nz2026)).toBe($(1_234.57));
  });

  it('gives nothing to a period outside the year', () => {
    const earned = { startsOn: '2027-05-01', endsOn: '2027-05-14' };
    expect(apportion($(2_000), earned, nz2026)).toBe(0);
  });

  it('splits a fortnight that straddles 31 March by days', () => {
    // 25 Mar – 7 Apr 2027 is 14 days: 7 in 2026-27, 7 in 2027-28.
    const earned = { startsOn: '2027-03-25', endsOn: '2027-04-07' };
    expect(overlapDays(earned, nz2026)).toBe(7);
    expect(apportion($(2_800), earned, nz2026)).toBe($(1_400));
    expect(apportion($(2_800), earned, nzYearRange('2027-28'))).toBe($(1_400));
    expect(straddles(earned, nz2026)).toBe(true);
  });

  it('loses nothing across the boundary: the two halves add back to the whole', () => {
    const earned = { startsOn: '2027-03-20', endsOn: '2027-04-09' };
    const first = apportion($(5_000), earned, nz2026);
    const second = apportion($(5_000), earned, nzYearRange('2027-28'));
    expect(first + second).toBe($(5_000));
  });

  it('splits a full AU financial year across two NZ tax years', () => {
    // The AU year starts three months after the NZ year, so a full year of
    // Australian work lands in two NZ years: 1 Jul 2026 – 31 Mar 2027 is 274
    // days, and the remaining 1 Apr – 30 Jun 2027 is 91.
    const auYear = auYearRange('2026-27');
    expect(overlapDays(auYear, nz2026)).toBe(274);
    expect(overlapDays(auYear, nzYearRange('2027-28'))).toBe(91);
    expect(overlapDays(auYear, nz2026) + overlapDays(auYear, nzYearRange('2027-28'))).toBe(365);
  });
});

describe('currency conversion', () => {
  it('leaves an amount alone at a rate of 1', () => {
    expect(toResidenceCurrency($(1_000), 1)).toBe($(1_000));
  });

  it('converts AUD to NZD and rounds to the cent', () => {
    expect(toResidenceCurrency($(1_000), 1.0873)).toBe($(1_087.3));
  });

  it('refuses to zero out an amount on a nonsense rate', () => {
    expect(toResidenceCurrency($(1_000), 0)).toBe($(1_000));
    expect(toResidenceCurrency($(1_000), Number.NaN)).toBe($(1_000));
  });
});

describe('part-time work across the Tasman', () => {
  const nzBase = {
    year: '2026-27',
    employmentIncome: 0,
    payeWithheld: 0,
    selfEmployedIncome: $(70_000),
    businessExpenses: $(10_000),
    hasStudentLoan: false,
  };
  const auBase = {
    year: '2026-27',
    employmentIncome: 0,
    paygWithheld: 0,
    businessIncome: 0,
    businessExpenses: 0,
    hasHelpDebt: false,
  };

  it('raises, not lowers, the bill of an NZ resident taking AU part-time work', () => {
    const studioOnly = calculateCombined({ residence: 'NZ', nz: nzBase, au: auBase });

    // AU$20,000 of part-time work with AU$3,000 PAYG withheld, at 1.09.
    const gross = toResidenceCurrency($(20_000), 1.09);
    const withheld = toResidenceCurrency($(3_000), 1.09);
    const withPartTime = calculateCombined({
      residence: 'NZ',
      nz: nzBase,
      au: { ...auBase, employmentIncome: $(20_000), paygWithheld: $(3_000) },
      foreignIncomeInResidenceCurrency: gross,
      foreignTaxPaidInResidenceCurrency: withheld,
    });

    expect(gross).toBe($(21_800));
    expect(withPartTime.nz.taxableIncome).toBe(studioOnly.nz.taxableIncome + gross);
    expect(withPartTime.totalLiability).toBeGreaterThan(studioOnly.totalLiability);
    // The credit covers the withholding but not the whole of the extra NZ tax.
    expect(withPartTime.foreignTaxCredit.claimed).toBe(withheld);
  });

  it('lifts the reserve rate, because the studio income is now taxed higher up', () => {
    const studioOnly = calculateCombined({ residence: 'NZ', nz: nzBase, au: auBase });
    const withPartTime = calculateCombined({
      residence: 'NZ',
      nz: nzBase,
      au: auBase,
      foreignIncomeInResidenceCurrency: $(40_000),
      foreignTaxPaidInResidenceCurrency: $(6_000),
    });
    expect(withPartTime.reserve.likely.rate).toBeGreaterThan(studioOnly.reserve.likely.rate);
  });

  it('charges no ACC earner levy on the overseas earnings', () => {
    const withPartTime = calculateCombined({
      residence: 'NZ',
      nz: nzBase,
      au: auBase,
      foreignIncomeInResidenceCurrency: $(21_800),
      foreignTaxPaidInResidenceCurrency: $(3_270),
    });
    // ACC is levied on the self-employed profit only, never on the foreign slice.
    expect(withPartTime.nz.acc.liableEarnings).toBe($(60_000));
  });

  it('does charge NZ student loan on the overseas earnings', () => {
    const withLoan = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, hasStudentLoan: true },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(21_800),
      foreignTaxPaidInResidenceCurrency: $(3_270),
    });
    const withoutForeign = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, hasStudentLoan: true },
      au: auBase,
    });
    expect(withLoan.nz.studentLoanRepayment).toBeGreaterThan(
      withoutForeign.nz.studentLoanRepayment,
    );
  });

  it('charges the AU Medicare levy on an AU resident’s NZ earnings', () => {
    const auNzBase = { ...nzBase, selfEmployedIncome: 0, businessExpenses: 0 };
    const withForeign = calculateCombined({
      residence: 'AU',
      nz: auNzBase,
      au: { ...auBase, businessIncome: $(60_000) },
      foreignIncomeInResidenceCurrency: $(20_000),
      foreignTaxPaidInResidenceCurrency: $(2_000),
    });
    const withoutForeign = calculateCombined({
      residence: 'AU',
      nz: auNzBase,
      au: { ...auBase, businessIncome: $(60_000) },
    });
    expect(withForeign.au.medicareLevy).toBeGreaterThan(withoutForeign.au.medicareLevy);
    expect(withForeign.au.taxableIncome).toBe($(80_000));
  });

  it('warns that the foreign earnings are taxed at home', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: nzBase,
      au: auBase,
      foreignIncomeInResidenceCurrency: $(21_800),
      foreignTaxPaidInResidenceCurrency: $(3_270),
    });
    expect(r.warnings.some((w) => w.includes('worldwide income') || w.includes('Australian earnings'))).toBe(true);
  });
});
