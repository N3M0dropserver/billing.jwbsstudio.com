import { describe, it, expect } from 'vitest';
import { calculateAu, auFinancialYearFor, medicareLevy, helpRepayment } from '~/lib/tax/au';
import { progressiveTax } from '~/lib/tax/progressive';
import { auRates } from '~/lib/tax/rates';

const $ = (d: number) => Math.round(d * 100);

const base = {
  year: '2026-27',
  employmentIncome: 0,
  paygWithheld: 0,
  businessIncome: 0,
  businessExpenses: 0,
  hasHelpDebt: false,
};

describe('AU financial year boundaries', () => {
  it('puts 1 July in the new financial year', () => {
    expect(auFinancialYearFor(new Date('2026-07-01T00:00:00Z'))).toBe('2026-27');
  });
  it('puts 30 June in the old financial year', () => {
    expect(auFinancialYearFor(new Date('2026-06-30T00:00:00Z'))).toBe('2025-26');
  });
});

describe('AU progressive income tax — 2025-26 (16% bracket)', () => {
  const brackets = auRates('2025-26').incomeTax.value;

  it('applies the tax-free threshold', () => {
    expect(progressiveTax($(18_200), brackets).total).toBe(0);
  });

  it('reproduces the ATO base amount at $45,000', () => {
    // ATO publishes "$4,288 plus 30c for each $1 over $45,000"
    expect(progressiveTax($(45_000), brackets).total).toBe($(4_288));
  });

  it('reproduces the ATO base amount at $135,000', () => {
    // ATO publishes "$31,288 plus 37c for each $1 over $135,000"
    expect(progressiveTax($(135_000), brackets).total).toBe($(31_288));
  });

  it('reproduces the ATO base amount at $190,000', () => {
    // 31,288 + 55,000 * 37% = 51,638
    expect(progressiveTax($(190_000), brackets).total).toBe($(51_638));
  });
});

describe('AU progressive income tax — 2026-27 (15% bracket)', () => {
  const brackets = auRates('2026-27').incomeTax.value;

  it('drops the base at $45,000 to $4,020 after the rate cut', () => {
    // 26,800 * 15% = 4,020
    expect(progressiveTax($(45_000), brackets).total).toBe($(4_020));
  });

  it('saves $268 a year for anyone earning over $45,000', () => {
    const before = progressiveTax($(90_000), auRates('2025-26').incomeTax.value).total;
    const after = progressiveTax($(90_000), brackets).total;
    expect(before - after).toBe($(268));
  });

  it('reproduces the derived top base of $51,370', () => {
    expect(progressiveTax($(190_000), brackets).total).toBe($(51_370));
  });
});

describe('AU Medicare levy', () => {
  const rates = auRates('2026-27');
  const lower = rates.medicareLevy.lowIncomeThresholdSingle.value;

  it('is nil at or below the low-income threshold', () => {
    expect(medicareLevy(lower, rates)).toBe(0);
    expect(medicareLevy($(20_000), rates)).toBe(0);
  });

  it('shades in at 10c in the dollar just above the threshold', () => {
    expect(medicareLevy(lower + $(1_000), rates)).toBe($(100));
  });

  it('reaches the full 2% exactly where the shade-in meets it', () => {
    // upper = lower * 0.10 / (0.10 - 0.02) = lower / 0.8
    const upper = Math.round(lower / 0.8);
    expect(medicareLevy(upper, rates)).toBe(Math.round(upper * 0.02));
  });

  it('is a flat 2% well above the shade-in range', () => {
    expect(medicareLevy($(100_000), rates)).toBe($(2_000));
  });

  it('never exceeds 2% of income inside the shade-in range', () => {
    for (let income = lower; income < Math.round(lower / 0.8); income += $(250)) {
      expect(medicareLevy(income, rates)).toBeLessThanOrEqual(Math.round(income * 0.02));
    }
  });
});

describe('AU HELP repayment — marginal since 1 July 2025', () => {
  const rates = auRates('2026-27');

  it('is nil below the threshold', () => {
    expect(helpRepayment($(69_528), rates)).toBe(0);
  });

  it('charges 15c only on income above the threshold, not the whole income', () => {
    const r = helpRepayment($(79_528), rates);
    expect(r).toBe($(1_500));
    // Under the OLD whole-of-income system this would have been ~15% of 79,528.
    expect(r).toBeLessThan(Math.round($(79_528) * 0.15));
  });

  it('reproduces the published second-bracket base of $9,028.35', () => {
    // (129,717 - 69,528) * 15% = 9,028.35
    expect(helpRepayment($(129_717), rates)).toBe($(9_028.35));
  });

  it('switches to a flat 10% of total income at the top floor', () => {
    const floor = rates.help.flatRateFloor.value;
    expect(helpRepayment(floor, rates)).toBe(Math.round(floor * 0.10));
  });

  it('is nil when the taxpayer has no HELP debt', () => {
    const r = calculateAu({ ...base, businessIncome: $(150_000), hasHelpDebt: false });
    expect(r.helpRepayment).toBe(0);
  });
});

describe('AU sole trader position', () => {
  it('taxes net profit, not gross receipts', () => {
    const r = calculateAu({
      ...base,
      businessIncome: $(120_000),
      businessExpenses: $(40_000),
    });
    expect(r.netBusinessProfit).toBe($(80_000));
    expect(r.taxableIncome).toBe($(80_000));
  });

  it('subtracts depreciation from taxable income', () => {
    const r = calculateAu({
      ...base,
      businessIncome: $(100_000),
      businessExpenses: $(10_000),
      depreciation: $(15_000),
    });
    expect(r.taxableIncome).toBe($(75_000));
  });

  it('credits PAYG withholding from a part-time job', () => {
    const r = calculateAu({
      ...base,
      employmentIncome: $(50_000),
      paygWithheld: $(7_000),
      businessIncome: $(40_000),
    });
    expect(r.balanceOwing).toBe(r.grossLiability - $(7_000));
  });

  it('stacks business income on top of salary at the margin', () => {
    const r = calculateAu({
      ...base,
      employmentIncome: $(80_000),
      businessIncome: $(40_000),
    });
    expect(r.marginalRate).toBe(0.30);
    expect(r.taxableIncome).toBe($(120_000));
  });
});

describe('AU PAYG instalments', () => {
  it('is not required below the instalment income threshold', () => {
    const r = calculateAu({ ...base, businessIncome: $(3_000) });
    expect(r.paygInstalments.required).toBe(false);
  });

  it('is required once both entry thresholds are met', () => {
    const r = calculateAu({ ...base, businessIncome: $(90_000) });
    expect(r.paygInstalments.required).toBe(true);
  });

  it('splits into four quarters that sum to the annual estimate', () => {
    const r = calculateAu({ ...base, businessIncome: $(90_000) });
    const sum = r.paygInstalments.quarterly.reduce((a, q) => a + q.amount, 0);
    expect(sum).toBe(r.paygInstalments.estimatedAnnual);
    expect(r.paygInstalments.quarterly).toHaveLength(4);
  });

  it('dates Q1 at 28 October of the financial year', () => {
    const r = calculateAu({ ...base, year: '2026-27', businessIncome: $(90_000) });
    expect(r.paygInstalments.quarterly[0]!.dueOn).toBe('2026-10-28');
  });
});

describe('AU deductible super', () => {
  it('reduces taxable income', () => {
    const without = calculateAu({ ...base, businessIncome: $(100_000) });
    const with_ = calculateAu({ ...base, businessIncome: $(100_000), superContribution: $(15_000) });
    expect(with_.taxableIncome).toBe(without.taxableIncome - $(15_000));
    expect(with_.incomeTax.total).toBeLessThan(without.incomeTax.total);
  });

  it('does not reduce HELP repayment income — super is added back', () => {
    const without = calculateAu({ ...base, businessIncome: $(100_000), hasHelpDebt: true });
    const with_ = calculateAu({
      ...base,
      businessIncome: $(100_000),
      superContribution: $(15_000),
      hasHelpDebt: true,
    });
    expect(with_.helpRepayment).toBe(without.helpRepayment);
  });

  it('tracks the remaining concessional cap', () => {
    const r = calculateAu({ ...base, businessIncome: $(100_000), superContribution: $(10_000) });
    expect(r.superNote.capRemaining).toBe($(20_000));
  });
});

describe('AU reserve rate', () => {
  it('includes the Medicare levy on top of the marginal rate', () => {
    const r = calculateAu({ ...base, businessIncome: $(100_000) });
    expect(r.recommendedReserveRate).toBeCloseTo(0.30 + 0.02, 10);
  });

  it('includes the HELP repayment rate when a debt exists', () => {
    const r = calculateAu({ ...base, businessIncome: $(100_000), hasHelpDebt: true });
    expect(r.recommendedReserveRate).toBeCloseTo(0.30 + 0.02 + 0.15, 10);
  });
});
