import type { Bracket } from './rates';
import { type Cents, applyRate, atLeastZero } from './money';

export interface BracketBreakdown {
  from: Cents;
  to: Cents | null;
  rate: number;
  /** Portion of income that fell in this bracket. */
  incomeInBracket: Cents;
  tax: Cents;
}

export interface ProgressiveResult {
  total: Cents;
  breakdown: BracketBreakdown[];
  /** Rate applying to the next dollar earned. */
  marginalRate: number;
  /** total / income. Zero when income is zero. */
  effectiveRate: number;
}

/**
 * Apply a progressive bracket table to an amount.
 *
 * Brackets are half-open: a bracket `{ from: X, rate: R }` taxes income in
 * (X, nextFrom] at R. This matches how both IRD and the ATO express
 * thresholds ("$45,001 to $135,000" == income above $45,000).
 *
 * Cumulative base amounts (the ATO's "$4,288 plus 30c for each $1 over
 * $45,000") are derived here rather than stored, so there is nothing to
 * transcribe incorrectly when rates change.
 */
export function progressiveTax(income: Cents, brackets: Bracket[]): ProgressiveResult {
  const taxable = atLeastZero(income);
  const sorted = [...brackets].sort((a, b) => a.from - b.from);

  const breakdown: BracketBreakdown[] = [];
  let total = 0;
  let marginalRate = sorted.length > 0 ? sorted[0]!.rate : 0;

  for (let i = 0; i < sorted.length; i++) {
    const bracket = sorted[i]!;
    const next = sorted[i + 1];
    const ceiling = next ? next.from : null;

    if (taxable <= bracket.from) {
      breakdown.push({ from: bracket.from, to: ceiling, rate: bracket.rate, incomeInBracket: 0, tax: 0 });
      continue;
    }

    const top = ceiling === null ? taxable : Math.min(taxable, ceiling);
    const incomeInBracket = atLeastZero(top - bracket.from);
    const tax = applyRate(incomeInBracket, bracket.rate);

    total += tax;
    if (incomeInBracket > 0) marginalRate = bracket.rate;

    breakdown.push({ from: bracket.from, to: ceiling, rate: bracket.rate, incomeInBracket, tax });
  }

  return {
    total,
    breakdown,
    marginalRate,
    effectiveRate: taxable > 0 ? total / taxable : 0,
  };
}

/**
 * Tax on the top slice of income — what an extra `amount` of income costs in
 * tax when you already have `baseIncome`. This is what drives the "reserve
 * this much of each invoice" figure: reserving at the average rate
 * under-reserves, because new work is taxed at the margin.
 */
export function marginalTaxOn(baseIncome: Cents, amount: Cents, brackets: Bracket[]): Cents {
  if (amount <= 0) return 0;
  const withAmount = progressiveTax(baseIncome + amount, brackets).total;
  const withoutAmount = progressiveTax(baseIncome, brackets).total;
  return atLeastZero(withAmount - withoutAmount);
}
