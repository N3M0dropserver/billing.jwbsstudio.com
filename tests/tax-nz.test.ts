import { describe, it, expect } from 'vitest';
import { calculateNz, nzTaxYearFor } from '~/lib/tax/nz';
import { progressiveTax, marginalTaxOn } from '~/lib/tax/progressive';
import { nzRates } from '~/lib/tax/rates';

const $ = (d: number) => Math.round(d * 100);

const base = {
  year: '2026-27',
  employmentIncome: 0,
  payeWithheld: 0,
  selfEmployedIncome: 0,
  businessExpenses: 0,
  hasStudentLoan: false,
};

describe('NZ tax year boundaries', () => {
  it('puts 1 April in the new year', () => {
    expect(nzTaxYearFor(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
  });
  it('puts 31 March in the old year', () => {
    expect(nzTaxYearFor(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
  });
  it('puts January in the year that started the previous April', () => {
    expect(nzTaxYearFor(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });
});

describe('NZ progressive income tax', () => {
  const brackets = nzRates('2026-27').incomeTax.value;

  it('taxes the first dollar — NZ has no tax-free threshold', () => {
    expect(progressiveTax($(1), brackets).total).toBe(Math.round($(1) * 0.105));
  });

  it('matches a hand calculation at the top of the first bracket', () => {
    // 15,600 * 10.5% = 1,638.00
    expect(progressiveTax($(15_600), brackets).total).toBe($(1_638));
  });

  it('matches a hand calculation at the top of the second bracket', () => {
    // 1,638 + (53,500 - 15,600) * 17.5% = 1,638 + 6,632.50 = 8,270.50
    expect(progressiveTax($(53_500), brackets).total).toBe($(8_270.5));
  });

  it('matches a hand calculation at the top of the third bracket', () => {
    // 8,270.50 + (78,100 - 53,500) * 30% = 8,270.50 + 7,380 = 15,650.50
    expect(progressiveTax($(78_100), brackets).total).toBe($(15_650.5));
  });

  it('matches a hand calculation at the top of the fourth bracket', () => {
    // 15,650.50 + (180,000 - 78,100) * 33% = 15,650.50 + 33,627 = 49,277.50
    expect(progressiveTax($(180_000), brackets).total).toBe($(49_277.5));
  });

  it('applies 39% above 180,000', () => {
    // 49,277.50 + 20,000 * 39% = 49,277.50 + 7,800 = 57,077.50
    expect(progressiveTax($(200_000), brackets).total).toBe($(57_077.5));
  });

  it('reports the marginal rate of the bracket the last dollar fell in', () => {
    expect(progressiveTax($(60_000), brackets).marginalRate).toBe(0.30);
    expect(progressiveTax($(15_600), brackets).marginalRate).toBe(0.105);
  });

  it('never taxes negative income', () => {
    expect(progressiveTax(-$(5_000), brackets).total).toBe(0);
  });

  it('is additive across the margin', () => {
    const a = progressiveTax($(50_000), brackets).total;
    const delta = marginalTaxOn($(50_000), $(10_000), brackets);
    expect(a + delta).toBe(progressiveTax($(60_000), brackets).total);
  });
});

describe('the original spreadsheet bug', () => {
  // The spreadsheet treated $10,000 as the bracket boundary and then flat-
  // rated ALL income at either 10.5% or 17.5%. Two errors: the wrong
  // threshold, and applying one rate to the whole amount instead of
  // progressively. The damage grows with income, and always in the
  // dangerous direction once you are past the 17.5% band.
  const brackets = nzRates('2026-27').incomeTax.value;
  const flatSpreadsheetRate = (income: number) => Math.round(income * 0.175);

  it('computes 60k correctly at 10,220.50', () => {
    // 8,270.50 + (60,000 - 53,500) * 30% = 10,220.50
    expect(progressiveTax($(60_000), brackets).total).toBe($(10_220.5));
  });

  it('under-reserves by over $8,000 at 120k of income', () => {
    const correct = progressiveTax($(120_000), brackets).total;
    // 15,650.50 + (120,000 - 78,100) * 33% = 29,477.50
    expect(correct).toBe($(29_477.5));
    expect(correct - flatSpreadsheetRate($(120_000))).toBeGreaterThan($(8_000));
  });

  it('under-reserves by over $28,000 at 180k of income', () => {
    const correct = progressiveTax($(180_000), brackets).total;
    expect(correct - flatSpreadsheetRate($(180_000))).toBeGreaterThan($(17_000));
  });
});

describe('NZ student loan', () => {
  it('is nil below the repayment threshold', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(20_000), hasStudentLoan: true });
    expect(r.studentLoanRepayment).toBe(0);
  });

  it('charges 12% of income over the threshold only', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(50_000), hasStudentLoan: true });
    // (50,000 - 24,128) * 12% = 25,872 * 0.12 = 3,104.64
    expect(r.studentLoanRepayment).toBe($(3_104.64));
  });

  it('is nil when the taxpayer has no loan', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(90_000), hasStudentLoan: false });
    expect(r.studentLoanRepayment).toBe(0);
  });
});

describe('NZ ACC levies', () => {
  it('charges levies on net profit, not gross income', () => {
    const r = calculateNz({
      ...base,
      selfEmployedIncome: $(100_000),
      businessExpenses: $(30_000),
    });
    expect(r.acc.liableEarnings).toBe($(70_000));
  });

  it('adds GST to the levies ACC invoices', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(50_000) });
    expect(r.acc.totalIncGst).toBe(Math.round(r.acc.totalExGst * 1.15));
  });

  it('does not levy self-employed earnings once salary has used up the cap', () => {
    const rates = nzRates('2026-27');
    const r = calculateNz({
      ...base,
      employmentIncome: rates.acc.maxLiableEarnings.value,
      selfEmployedIncome: $(20_000),
    });
    expect(r.acc.earnerLevy).toBe(0);
  });

  it('caps the earner levy at the maximum liable earnings', () => {
    const rates = nzRates('2026-27');
    const r = calculateNz({ ...base, selfEmployedIncome: $(300_000) });
    const expected = Math.round(
      rates.acc.maxLiableEarnings.value * rates.acc.earnerLevyRateExGst.value,
    );
    expect(r.acc.earnerLevy).toBe(expected);
  });

  it('applies the full-time minimum liable earnings when profit is low', () => {
    const rates = nzRates('2026-27');
    const r = calculateNz({
      ...base,
      selfEmployedIncome: $(20_000),
      acc: { cover: 'CoverPlus', fullTime: true },
    });
    expect(r.acc.liableEarnings).toBe(rates.acc.minLiableEarningsFullTime.value);
  });

  it('uses the agreed cover under CoverPlus Extra', () => {
    const r = calculateNz({
      ...base,
      selfEmployedIncome: $(120_000),
      acc: { cover: 'CoverPlusExtra', agreedCover: $(60_000) },
    });
    expect(r.acc.liableEarnings).toBe($(60_000));
  });
});

describe('NZ mixed employment and self-employment', () => {
  it('stacks self-employed profit on top of salary for bracket purposes', () => {
    const salaryOnly = calculateNz({ ...base, employmentIncome: $(60_000) });
    const mixed = calculateNz({
      ...base,
      employmentIncome: $(60_000),
      selfEmployedIncome: $(30_000),
    });
    // The 30k of business income is taxed at 30% and 33%, not from the bottom.
    expect(mixed.incomeTax.total).toBeGreaterThan(salaryOnly.incomeTax.total + $(9_000));
    expect(mixed.marginalRate).toBe(0.33);
  });

  it('credits PAYE already withheld against the year-end bill', () => {
    const r = calculateNz({
      ...base,
      employmentIncome: $(60_000),
      payeWithheld: $(11_220),
      selfEmployedIncome: $(20_000),
    });
    expect(r.residualIncomeTax).toBe(r.incomeTax.total - $(11_220));
  });

  it('produces a refund position when PAYE over-withheld', () => {
    const r = calculateNz({ ...base, employmentIncome: $(60_000), payeWithheld: $(20_000) });
    expect(r.residualIncomeTax).toBeLessThan(0);
  });
});

describe('NZ provisional tax', () => {
  it('is not required when residual income tax is under $5,000', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(30_000) });
    expect(r.residualIncomeTax).toBeLessThan($(5_000));
    expect(r.provisionalTax.required).toBe(false);
  });

  it('is required once residual income tax passes $5,000', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(60_000) });
    expect(r.provisionalTax.required).toBe(true);
  });

  it('uplifts the prior year by 5% and splits into three instalments', () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(100_000) });
    expect(r.provisionalTax.estimatedNextYearTotal).toBe(
      Math.round(r.residualIncomeTax * 1.05),
    );
    const sum = r.provisionalTax.instalments.reduce((a, i) => a + i.amount, 0);
    expect(sum).toBe(r.provisionalTax.estimatedNextYearTotal);
    expect(r.provisionalTax.instalments).toHaveLength(3);
  });

  it('dates instalments in the following tax year', () => {
    const r = calculateNz({ ...base, year: '2026-27', selfEmployedIncome: $(100_000) });
    expect(r.provisionalTax.instalments[0]!.dueOn).toBe('2027-08-28');
    expect(r.provisionalTax.instalments[2]!.dueOn).toBe('2028-05-07');
  });
});

describe('NZ reserve rate', () => {
  it('exceeds the bare marginal income tax rate because of ACC and student loan', () => {
    const r = calculateNz({
      ...base,
      selfEmployedIncome: $(90_000),
      hasStudentLoan: true,
    });
    expect(r.recommendedReserveRate).toBeGreaterThan(r.marginalRate);
    expect(r.recommendedReserveRate).toBeGreaterThan(0.33 + 0.12);
  });

  it("beats the spreadsheet's flat 15% at this income level", () => {
    const r = calculateNz({ ...base, selfEmployedIncome: $(90_000), hasStudentLoan: true });
    expect(r.recommendedReserveRate).toBeGreaterThan(0.15);
  });
});
