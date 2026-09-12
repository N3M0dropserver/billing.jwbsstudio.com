import { type Cents, applyRate, atLeastZero } from './money';
import { progressiveTax, marginalTaxOn, type ProgressiveResult } from './progressive';
import { auRates, type AuRates } from './rates';

export interface AuInput {
  year: string;
  /** Gross salary/wages before PAYG withholding. */
  employmentIncome: Cents;
  /** PAYG withholding already taken by an employer. */
  paygWithheld: Cents;
  /** Gross business income (GST-exclusive if registered). */
  businessIncome: Cents;
  /** Deductible business expenses (GST-exclusive if registered). */
  businessExpenses: Cents;
  /** Depreciation / decline in value claimed. */
  depreciation?: Cents;
  /** Work-related and other personal deductions. */
  personalDeductions?: Cents;
  otherIncome?: Cents;
  otherTaxCredits?: Cents;
  hasHelpDebt: boolean;
  /** Whether private hospital cover is held (affects Medicare levy surcharge). */
  hasPrivateHospitalCover?: boolean;
  /** Personal deductible super contribution. */
  superContribution?: Cents;
}

export interface AuResult {
  year: string;
  rates: AuRates;

  netBusinessProfit: Cents;
  taxableIncome: Cents;

  incomeTax: ProgressiveResult;
  medicareLevy: Cents;
  helpRepayment: Cents;

  /** Total tax + levies before credits. */
  grossLiability: Cents;
  /** After PAYG withholding and other credits. Negative means a refund. */
  balanceOwing: Cents;
  totalSelfEmployedCost: Cents;

  marginalRate: number;
  effectiveRate: number;
  recommendedReserveRate: number;

  paygInstalments: {
    required: boolean;
    estimatedAnnual: Cents;
    quarterly: Array<{ dueOn: string; amount: Cents; label: string }>;
    note: string;
  };

  superNote: {
    contributed: Cents;
    capRemaining: Cents;
    taxSavedByContributing: Cents;
    note: string;
  };
}

/** AU financial year for a date: 1 July to 30 June, labelled by both years. */
export function auFinancialYearFor(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0 = Jan
  const startYear = m >= 6 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Medicare levy with the low-income shade-in.
 *
 * Below the low-income threshold: nil. Above it the levy phases in at 10c in
 * the dollar until it reaches the full 2% of taxable income — which happens
 * at threshold / 0.8. That upper point is derived here rather than stored,
 * because secondary sources routinely pair a current-year lower threshold
 * with a prior-year upper one.
 */
export function medicareLevy(taxableIncome: Cents, rates: AuRates): Cents {
  const lower = rates.medicareLevy.lowIncomeThresholdSingle.value;
  const fullRate = rates.medicareLevy.rate.value;
  const shadeIn = rates.medicareLevy.shadeInRate.value;

  if (taxableIncome <= lower) return 0;

  // The shade-in ends where it meets the full levy:
  //   shadeIn * (income - lower) == fullRate * income
  //   => income == lower * shadeIn / (shadeIn - fullRate)
  const upper = Math.round((lower * shadeIn) / (shadeIn - fullRate));

  if (taxableIncome >= upper) {
    return applyRate(taxableIncome, fullRate);
  }
  return applyRate(taxableIncome - lower, shadeIn);
}

/**
 * Compulsory HELP/HECS repayment.
 *
 * Marginal since 1 July 2025 — you repay only on income above each
 * threshold, like income tax. Above the flat-rate floor the calculation
 * switches to a flat share of TOTAL repayment income.
 *
 * Repayment income is strictly taxable income plus reportable fringe
 * benefits, reportable super contributions, net investment losses and exempt
 * foreign income. This uses taxable income plus any deductible super
 * contribution, which covers the common sole-trader case.
 */
export function helpRepayment(repaymentIncome: Cents, rates: AuRates): Cents {
  const floor = rates.help.flatRateFloor.value;
  if (repaymentIncome >= floor) {
    return applyRate(repaymentIncome, rates.help.flatRate.value);
  }
  return progressiveTax(repaymentIncome, rates.help.brackets.value).total;
}

function paygQuarterDates(year: string): Array<{ dueOn: string; label: string }> {
  const startYear = Number.parseInt(year.slice(0, 4), 10);
  return [
    { dueOn: `${startYear}-10-28`, label: 'Q1 (Jul–Sep)' },
    { dueOn: `${startYear + 1}-02-28`, label: 'Q2 (Oct–Dec)' },
    { dueOn: `${startYear + 1}-04-28`, label: 'Q3 (Jan–Mar)' },
    { dueOn: `${startYear + 1}-07-28`, label: 'Q4 (Apr–Jun)' },
  ];
}

export function calculateAu(input: AuInput): AuResult {
  const rates = auRates(input.year);

  const netBusinessProfit =
    input.businessIncome - input.businessExpenses - (input.depreciation ?? 0);

  const taxableIncome = atLeastZero(
    input.employmentIncome +
      netBusinessProfit +
      (input.otherIncome ?? 0) -
      (input.personalDeductions ?? 0) -
      (input.superContribution ?? 0),
  );

  const incomeTax = progressiveTax(taxableIncome, rates.incomeTax.value);
  const levy = medicareLevy(taxableIncome, rates);

  // Deductible super is added back for HELP repayment income.
  const repaymentIncome = taxableIncome + (input.superContribution ?? 0);
  const help = input.hasHelpDebt ? helpRepayment(repaymentIncome, rates) : 0;

  const grossLiability = incomeTax.total + levy + help;
  const credits = input.paygWithheld + (input.otherTaxCredits ?? 0);
  const balanceOwing = grossLiability - credits;

  const selfEmployedSlice = atLeastZero(netBusinessProfit);
  const marginalIncomeTax = marginalTaxOn(
    input.employmentIncome,
    selfEmployedSlice,
    rates.incomeTax.value,
  );
  const totalSelfEmployedCost =
    marginalIncomeTax +
    applyRate(selfEmployedSlice, rates.medicareLevy.rate.value) +
    (input.hasHelpDebt
      ? atLeastZero(helpRepayment(repaymentIncome, rates) - helpRepayment(atLeastZero(repaymentIncome - selfEmployedSlice), rates))
      : 0);

  const helpMarginalRate = input.hasHelpDebt
    ? repaymentIncome >= rates.help.flatRateFloor.value
      ? rates.help.flatRate.value
      : progressiveTax(repaymentIncome, rates.help.brackets.value).marginalRate
    : 0;
  const recommendedReserveRate =
    incomeTax.marginalRate + rates.medicareLevy.rate.value + helpMarginalRate;

  const paygRequired =
    netBusinessProfit + (input.otherIncome ?? 0) >= rates.paygInstalments.instalmentIncomeThreshold.value &&
    balanceOwing >= rates.paygInstalments.taxPayableThreshold.value;
  const estimatedAnnual = paygRequired ? atLeastZero(balanceOwing) : 0;
  const perQuarter = Math.round(estimatedAnnual / 4);

  const capRemaining = atLeastZero(
    rates.super.concessionalCap.value - (input.superContribution ?? 0),
  );
  const taxSavedByContributing = applyRate(
    Math.min(capRemaining, atLeastZero(taxableIncome)),
    atLeastZero(incomeTax.marginalRate + rates.medicareLevy.rate.value - 0.15),
  );

  return {
    year: input.year,
    rates,
    netBusinessProfit,
    taxableIncome,
    incomeTax,
    medicareLevy: levy,
    helpRepayment: help,
    grossLiability,
    balanceOwing,
    totalSelfEmployedCost,
    marginalRate: incomeTax.marginalRate,
    effectiveRate: incomeTax.effectiveRate,
    recommendedReserveRate,
    paygInstalments: {
      required: paygRequired,
      estimatedAnnual,
      quarterly: paygQuarterDates(input.year).map((q, i) => ({
        ...q,
        amount: i === 3 ? estimatedAnnual - perQuarter * 3 : perQuarter,
      })),
      note: paygRequired
        ? 'Your instalment income and tax payable are both over the ATO thresholds, so expect to be entered into PAYG instalments. The ATO sets your actual instalment rate — this is an estimate based on splitting your liability evenly.'
        : 'Below the PAYG instalment entry thresholds, so you would pay in one lump after lodging.',
    },
    superNote: {
      contributed: input.superContribution ?? 0,
      capRemaining,
      taxSavedByContributing,
      note:
        'Personal deductible super contributions are taxed at 15% inside the fund instead of your marginal rate. You must lodge a notice of intent with your fund and receive acknowledgement before lodging your return, or the deduction is denied.',
    },
  };
}
