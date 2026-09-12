import { type Cents, applyRate, atLeastZero } from './money';
import { progressiveTax, marginalTaxOn, type ProgressiveResult } from './progressive';
import { nzRates, type NzRates } from './rates';

export interface NzAccSettings {
  /**
   * Whether the self-employed person is on standard CoverPlus (levied on
   * actual liable earnings) or CoverPlus Extra (levied on an agreed amount).
   */
  cover: 'CoverPlus' | 'CoverPlusExtra';
  /** For CoverPlus Extra, the agreed cover amount. */
  agreedCover?: Cents;
  /** Your classification unit work levy rate, ex GST. Defaults to scheme average. */
  workLevyRateExGst?: number;
  /** Apply ACC's minimum liable earnings for full-time self-employment. */
  fullTime?: boolean;
}

export interface NzInput {
  year: string;
  /** Gross salary/wages, before PAYE. */
  employmentIncome: Cents;
  /** PAYE already withheld by an employer. */
  payeWithheld: Cents;
  /**
   * ACC earner levy already collected through PAYE on employment income.
   * Employment income is levied at source, so it is not levied again.
   */
  accEarnerLevyWithheld?: Cents;
  /** Gross self-employed income (GST-exclusive if registered). */
  selfEmployedIncome: Cents;
  /** Deductible business expenses (GST-exclusive if registered). */
  businessExpenses: Cents;
  /** Depreciation claimed for the year. */
  depreciation?: Cents;
  /** Any other taxable income (interest, dividends, foreign). */
  otherIncome?: Cents;
  /** Tax already credited on other income (RWT, imputation, foreign tax). */
  otherTaxCredits?: Cents;
  hasStudentLoan: boolean;
  acc?: NzAccSettings;
  /** Residual income tax from the prior year, for provisional tax uplift. */
  priorYearRit?: Cents;
}

export interface NzAccResult {
  earnerLevy: Cents;
  workLevy: Cents;
  workingSaferLevy: Cents;
  /** Levies ACC will invoice, ex GST. */
  totalExGst: Cents;
  /** What ACC actually bills, incl GST. Claimable back if GST registered. */
  totalIncGst: Cents;
  liableEarnings: Cents;
  notes: string[];
}

export interface NzResult {
  year: string;
  rates: NzRates;

  netBusinessProfit: Cents;
  taxableIncome: Cents;

  incomeTax: ProgressiveResult;
  acc: NzAccResult;
  studentLoanRepayment: Cents;

  /** Income tax less tax already withheld or credited. */
  residualIncomeTax: Cents;
  /** What you actually have to find at the end of the year. */
  balanceOwing: Cents;
  /** Everything owed on the self-employed slice: tax + ACC + student loan. */
  totalSelfEmployedCost: Cents;

  marginalRate: number;
  effectiveRate: number;
  /**
   * The share of each new self-employed dollar that should be set aside.
   * Includes income tax at the margin, ACC and student loan.
   */
  recommendedReserveRate: number;

  provisionalTax: {
    required: boolean;
    /** Instalments for NEXT year, based on this year's RIT uplifted 5%. */
    estimatedNextYearTotal: Cents;
    instalments: Array<{ dueOn: string; amount: Cents; label: string }>;
    note: string;
  };
}

/** NZ tax year for a date: 1 April to 31 March, labelled by the end year. */
export function nzTaxYearFor(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0 = Jan
  // Jan-Mar belong to the year that started the previous April.
  const startYear = m >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function calcAcc(input: NzInput, rates: NzRates): NzAccResult {
  const settings = input.acc ?? { cover: 'CoverPlus' as const };
  const notes: string[] = [];

  const netProfit = atLeastZero(
    input.selfEmployedIncome - input.businessExpenses - (input.depreciation ?? 0),
  );

  let liableEarnings: Cents;
  if (settings.cover === 'CoverPlusExtra' && settings.agreedCover !== undefined) {
    liableEarnings = settings.agreedCover;
    notes.push('Levied on your agreed CoverPlus Extra cover, not on actual profit.');
  } else {
    liableEarnings = netProfit;
    if (settings.fullTime && liableEarnings > 0) {
      const min = rates.acc.minLiableEarningsFullTime.value;
      if (liableEarnings < min) {
        liableEarnings = min;
        notes.push(
          'ACC applies a minimum level of liable earnings to full-time self-employed people, so your levy is based on that minimum rather than your actual profit.',
        );
      }
    }
  }

  const cap = rates.acc.maxLiableEarnings.value;
  // Employment income is already levied through PAYE and uses up the cap first.
  const capRemaining = atLeastZero(cap - Math.min(input.employmentIncome, cap));
  const earnerLevyBase = Math.min(liableEarnings, capRemaining);
  if (earnerLevyBase < liableEarnings) {
    notes.push(
      'Part of your self-employed earnings sits above the ACC earner levy cap (or the cap was used up by your salary), so no earner levy applies to that part.',
    );
  }

  const workLevyRate = settings.workLevyRateExGst ?? rates.acc.defaultWorkLevyRateExGst.value;
  if (settings.workLevyRateExGst === undefined && liableEarnings > 0) {
    notes.push(
      'Work levy uses the scheme-average rate. Enter your own classification unit rate from your ACC invoice in Settings for an accurate figure.',
    );
  }

  const earnerLevy = applyRate(earnerLevyBase, rates.acc.earnerLevyRateExGst.value);
  const workLevy = applyRate(liableEarnings, workLevyRate);
  const workingSaferLevy = applyRate(liableEarnings, rates.acc.workingSaferLevyRateExGst.value);
  const totalExGst = earnerLevy + workLevy + workingSaferLevy;

  return {
    earnerLevy,
    workLevy,
    workingSaferLevy,
    totalExGst,
    totalIncGst: applyRate(totalExGst, 1.15),
    liableEarnings,
    notes,
  };
}

function calcStudentLoan(taxableIncome: Cents, input: NzInput, rates: NzRates): Cents {
  if (!input.hasStudentLoan) return 0;
  const excess = atLeastZero(taxableIncome - rates.studentLoan.annualThreshold.value);
  return applyRate(excess, rates.studentLoan.rate.value);
}

/**
 * Provisional tax instalment dates for a standard 31 March balance date,
 * two-monthly GST or no GST registration.
 */
function provisionalInstalmentDates(year: string): Array<{ dueOn: string; label: string }> {
  const startYear = Number.parseInt(year.slice(0, 4), 10);
  // Instalments fall in the year AFTER the one whose RIT sets the uplift.
  const next = startYear + 1;
  return [
    { dueOn: `${next}-08-28`, label: 'Instalment 1' },
    { dueOn: `${next + 1}-01-15`, label: 'Instalment 2' },
    { dueOn: `${next + 1}-05-07`, label: 'Instalment 3' },
  ];
}

export function calculateNz(input: NzInput): NzResult {
  const rates = nzRates(input.year);

  const netBusinessProfit =
    input.selfEmployedIncome - input.businessExpenses - (input.depreciation ?? 0);

  const taxableIncome = atLeastZero(
    input.employmentIncome + netBusinessProfit + (input.otherIncome ?? 0),
  );

  const incomeTax = progressiveTax(taxableIncome, rates.incomeTax.value);
  const acc = calcAcc(input, rates);
  const studentLoanRepayment = calcStudentLoan(taxableIncome, input, rates);

  const credits = input.payeWithheld + (input.otherTaxCredits ?? 0);
  const residualIncomeTax = incomeTax.total - credits;
  const balanceOwing = residualIncomeTax + studentLoanRepayment + acc.totalIncGst;

  // Cost of the self-employed slice specifically: income tax at the margin
  // on top of employment income, plus ACC and student loan on that slice.
  const selfEmployedSlice = atLeastZero(netBusinessProfit);
  const marginalIncomeTax = marginalTaxOn(
    input.employmentIncome,
    selfEmployedSlice,
    rates.incomeTax.value,
  );
  const totalSelfEmployedCost =
    marginalIncomeTax +
    acc.totalIncGst +
    (input.hasStudentLoan ? applyRate(selfEmployedSlice, rates.studentLoan.rate.value) : 0);

  // Reserve rate on the NEXT dollar earned.
  const accMarginalRate =
    acc.liableEarnings < rates.acc.maxLiableEarnings.value
      ? (rates.acc.earnerLevyRateExGst.value +
          (input.acc?.workLevyRateExGst ?? rates.acc.defaultWorkLevyRateExGst.value) +
          rates.acc.workingSaferLevyRateExGst.value) *
        1.15
      : 0;
  const slMarginalRate =
    input.hasStudentLoan && taxableIncome > rates.studentLoan.annualThreshold.value
      ? rates.studentLoan.rate.value
      : 0;
  const recommendedReserveRate = incomeTax.marginalRate + accMarginalRate + slMarginalRate;

  const provisionalRequired = residualIncomeTax > rates.provisionalTax.threshold.value;
  const estimatedNextYearTotal = provisionalRequired
    ? applyRate(atLeastZero(residualIncomeTax), rates.provisionalTax.standardUpliftPriorYear.value)
    : 0;
  const perInstalment = Math.round(estimatedNextYearTotal / 3);

  return {
    year: input.year,
    rates,
    netBusinessProfit,
    taxableIncome,
    incomeTax,
    acc,
    studentLoanRepayment,
    residualIncomeTax,
    balanceOwing,
    totalSelfEmployedCost,
    marginalRate: incomeTax.marginalRate,
    effectiveRate: incomeTax.effectiveRate,
    recommendedReserveRate,
    provisionalTax: {
      required: provisionalRequired,
      estimatedNextYearTotal,
      instalments: provisionalInstalmentDates(input.year).map((d, i) => ({
        ...d,
        // Last instalment absorbs the rounding remainder.
        amount: i === 2 ? estimatedNextYearTotal - perInstalment * 2 : perInstalment,
      })),
      note: provisionalRequired
        ? `Your residual income tax is over the $${rates.provisionalTax.threshold.value / 100} threshold, so you will be a provisional taxpayer next year. The standard option uplifts this year's RIT by 5% and splits it into three instalments.`
        : `Residual income tax is under the $${rates.provisionalTax.threshold.value / 100} threshold, so no provisional tax next year — you pay in one lump on 7 February (or 7 April with a tax agent).`,
    },
  };
}
