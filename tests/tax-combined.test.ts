import { describe, it, expect } from 'vitest';
import { calculateCombined } from '~/lib/tax/engine';
import { unverifiedFigures } from '~/lib/tax/rates';

const $ = (d: number) => Math.round(d * 100);

const nzBase = {
  year: '2026-27',
  employmentIncome: 0,
  payeWithheld: 0,
  selfEmployedIncome: 0,
  businessExpenses: 0,
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

describe('combined position', () => {
  it('reports in the residence currency', () => {
    const nz = calculateCombined({ residence: 'NZ', nz: nzBase, au: auBase });
    expect(nz.currency).toBe('NZD');
    const au = calculateCombined({ residence: 'AU', nz: nzBase, au: auBase });
    expect(au.currency).toBe('AUD');
  });

  it('orders the reserve bands best <= likely <= worst by rate', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(90_000), businessExpenses: $(20_000), hasStudentLoan: true },
      au: auBase,
    });
    expect(r.reserve.best.rate).toBeLessThanOrEqual(r.reserve.likely.rate);
    expect(r.reserve.likely.rate).toBeLessThanOrEqual(r.reserve.worst.rate);
  });

  it('reserves less in the best case because deductions reduce the taxed slice', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(100_000), businessExpenses: $(30_000) },
      au: auBase,
    });
    expect(r.reserve.best.amount).toBeLessThan(r.reserve.worst.amount);
  });
});

describe('foreign tax credit', () => {
  it('is nil with no foreign income', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(80_000) },
      au: auBase,
    });
    expect(r.foreignTaxCredit.claimed).toBe(0);
  });

  it('credits foreign tax in full when it is below the domestic tax on that income', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(100_000) },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(20_000),
      foreignTaxPaidInResidenceCurrency: $(1_000),
    });
    expect(r.foreignTaxCredit.claimed).toBe($(1_000));
    expect(r.foreignTaxCredit.capped).toBe(false);
  });

  it('caps the credit at the domestic tax on the same income', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(100_000) },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(20_000),
      foreignTaxPaidInResidenceCurrency: $(15_000),
    });
    expect(r.foreignTaxCredit.capped).toBe(true);
    expect(r.foreignTaxCredit.claimed).toBeLessThan($(15_000));
    expect(r.foreignTaxCredit.claimed).toBeGreaterThan(0);
  });

  it('reduces the total liability by the credit claimed', () => {
    const withoutCredit = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(100_000) },
      au: auBase,
    });
    const withCredit = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(100_000) },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(20_000),
      foreignTaxPaidInResidenceCurrency: $(2_000),
    });
    expect(withCredit.totalLiability).toBe(withoutCredit.totalLiability - $(2_000));
  });

  it('never produces a negative total liability', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(30_000) },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(25_000),
      foreignTaxPaidInResidenceCurrency: $(90_000),
    });
    expect(r.totalLiability).toBeGreaterThanOrEqual(0);
  });
});

describe('warnings', () => {
  it('warns when NZ turnover crosses the GST threshold', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(80_000) },
      au: auBase,
    });
    expect(r.warnings.some((w) => /GST registration threshold/i.test(w))).toBe(true);
  });

  it('warns when approaching the NZ GST threshold', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(55_000) },
      au: auBase,
    });
    expect(r.warnings.some((w) => /within 20%/i.test(w))).toBe(true);
  });

  it('warns about dual-country income needing a residence determination', () => {
    const r = calculateCombined({
      residence: 'NZ',
      nz: { ...nzBase, selfEmployedIncome: $(40_000) },
      au: auBase,
      foreignIncomeInResidenceCurrency: $(20_000),
      foreignTaxPaidInResidenceCurrency: $(3_000),
    });
    expect(r.warnings.some((w) => /tie-breaker/i.test(w))).toBe(true);
  });
});

describe('rate table provenance', () => {
  it('surfaces figures that still need confirming rather than hiding them', () => {
    const r = calculateCombined({ residence: 'NZ', nz: nzBase, au: auBase });
    expect(Array.isArray(r.unverified)).toBe(true);
    for (const u of r.unverified) {
      expect(u.source).toMatch(/^https?:\/\//);
      expect(u.path.length).toBeGreaterThan(0);
    }
  });

  it('reports NZ and AU unverified figures separately', () => {
    expect(unverifiedFigures('NZ', '2026-27').length).toBeGreaterThan(0);
    expect(unverifiedFigures('AU', '2026-27').length).toBeGreaterThan(0);
  });

  it('throws a helpful error for a year with no rate table', () => {
    expect(() =>
      calculateCombined({ residence: 'NZ', nz: { ...nzBase, year: '2099-00' }, au: auBase }),
    ).toThrow(/No NZ rate table/);
  });
});
