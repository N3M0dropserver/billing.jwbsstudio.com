/**
 * Builds the full tax position for a year by pulling the recorded figures
 * out of D1 and handing them to the tax engine.
 *
 * This is the seam between "what happened" (database) and "what it means"
 * (tax engine). Keeping it in one place means the engine stays pure and
 * testable, and the queries stay free of tax rules.
 */

import type { Db } from '~/lib/db';
import type { Settings } from '~/lib/db/schema';
import { calculateCombined, type CombinedResult } from '~/lib/tax/engine';
import { checkTurnoverThreshold, type TurnoverCheck } from '~/lib/tax/gst';
import { resolveRatesYear } from '~/lib/tax/rates';
import type { Cents, Currency } from '~/lib/tax/money';
import {
  currentTaxYear,
  taxYearRange,
  getInvoiceTotals,
  getExpenseTotals,
  getDepreciationForYear,
  getIncomeForYear,
  getRollingTurnover,
  type IncomeForYear,
  type TurnoverByJurisdiction,
  type TaxYearRange,
  type InvoiceTotals,
  type ExpenseTotals,
} from './dashboard';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';

export interface TaxPosition {
  range: TaxYearRange;
  invoices: InvoiceTotals;
  expenses: ExpenseTotals;
  depreciation: Cents;
  /** Employment and other income, split domestic/foreign, in residence currency. */
  income: IncomeForYear;
  /** Rolling 12-month turnover per jurisdiction, each in its own currency. */
  turnover: TurnoverByJurisdiction;
  /** Salary or wages sourced in the country of residence. */
  employment: { grossIncome: Cents; taxWithheld: Cents; accLevyWithheld: Cents };
  otherIncome: { gross: Cents; credits: Cents };
  /**
   * Everything sourced in the OTHER country — a part-time job across the
   * Tasman, most often. Taxed at home with a credit for the tax withheld
   * there, which is why it is tracked apart from the domestic figures.
   */
  foreign: { grossIncome: Cents; taxPaid: Cents };
  result: CombinedResult;
  gst: TurnoverCheck;
  /** The same test for the other country's threshold, on supplies made there. */
  foreignGst: TurnoverCheck;
  /**
   * Amount that should currently be sitting in the tax account, based on
   * what has actually been RECEIVED so far this year.
   */
  shouldHaveReserved: Cents;
}

/**
 * Income is recognised on an invoiced basis by default, which is what both
 * IRD and the ATO expect unless you have elected a cash basis. The reserve
 * figure, though, is computed on money actually received — you cannot set
 * aside tax out of an invoice nobody has paid yet.
 */
export async function buildTaxPosition(
  db: Db,
  settings: Settings,
  options: { year?: string; now?: Date } = {},
): Promise<TaxPosition> {
  const now = options.now ?? new Date();
  const jurisdiction = settings.taxResidence;
  const resolvedRange =
    options.year && isValidYearLabel(options.year)
      ? taxYearRange(jurisdiction, options.year)
      : currentTaxYear(jurisdiction, now);

  const userId = settings.userId;

  // The currency the engine's figures are in follows tax RESIDENCE, not the
  // invoicing default — they are separate settings and can disagree.
  const residenceCurrency: Currency = jurisdiction === 'NZ' ? 'NZD' : 'AUD';

  const [invoiceTotals, expenseTotals, depreciation, income, rollingTurnover] =
    await Promise.all([
      getInvoiceTotals(db, userId, resolvedRange, residenceCurrency),
      getExpenseTotals(db, userId, resolvedRange, residenceCurrency),
      getDepreciationForYear(db, userId, resolvedRange.year),
      getIncomeForYear(db, userId, resolvedRange, residenceCurrency),
      getRollingTurnover(db, userId),
    ]);

  const employment = income.domesticEmployment;
  const other = {
    gross: income.domesticOther.grossIncome,
    credits: income.domesticOther.taxWithheld,
  };

  /**
   * The self-employed figure is GST-exclusive: GST collected is not your
   * income, it is the government's money passing through your account.
   *
   * It is also DOMESTIC only. Work invoiced under the other country's GST
   * rules is a supply made there, and it reaches the residence country's tax
   * base through the foreign-income path below instead — which is what allows
   * a credit for any tax paid on it. Feeding the lot in here would tax the
   * foreign slice at home with no credit against it.
   */
  const selfEmployedIncome = invoiceTotals.domestic.invoiced - invoiceTotals.domestic.gstCollected;
  const foreignBusinessIncome = invoiceTotals.foreign.invoiced - invoiceTotals.foreign.gstCollected;

  /**
   * Everything sourced in the other country, whatever its kind. The residence
   * country taxes it and credits the tax already paid there — it must NOT go
   * in alongside domestic credits, or the same tax is relieved twice.
   *
   * Foreign business income arrives NET of the costs of earning it, for the
   * same reason the domestic figure is reduced by domestic expenses: it is
   * profit that is taxable, not turnover. There is no withholding to credit
   * against it — tax on foreign self-employment is paid through that
   * country's own return, and belongs here only once you have paid it.
   */
  const foreign = {
    grossIncome:
      income.foreignEmployment.grossIncome +
      income.foreignOther.grossIncome +
      Math.max(foreignBusinessIncome - expenseTotals.foreignClaimable, 0),
    taxPaid: income.foreignEmployment.taxWithheld + income.foreignOther.taxWithheld,
  };

  /**
   * The engine must be handed a year it has a table for, or it throws. When
   * the current year has no table yet, `ratesYear` is the most recent one we
   * do hold and `range.ratesAreProvisional` is set so the page can say so.
   */
  const nzYear =
    jurisdiction === 'NZ'
      ? resolvedRange.ratesYear
      : resolveRatesYear('NZ', nzTaxYearFor(now)).ratesYear;
  const auYear =
    jurisdiction === 'AU'
      ? resolvedRange.ratesYear
      : resolveRatesYear('AU', auFinancialYearFor(now)).ratesYear;

  const result = calculateCombined({
    residence: jurisdiction,
    nz: {
      year: nzYear,
      employmentIncome: jurisdiction === 'NZ' ? employment.grossIncome : 0,
      payeWithheld: jurisdiction === 'NZ' ? employment.taxWithheld : 0,
      accEarnerLevyWithheld: employment.accLevyWithheld,
      selfEmployedIncome: jurisdiction === 'NZ' ? selfEmployedIncome : 0,
      businessExpenses: jurisdiction === 'NZ' ? expenseTotals.domesticClaimable : 0,
      depreciation: jurisdiction === 'NZ' ? depreciation : 0,
      otherIncome: jurisdiction === 'NZ' ? other.gross : 0,
      otherTaxCredits: jurisdiction === 'NZ' ? other.credits : 0,
      hasStudentLoan: settings.nzHasStudentLoan,
      acc: {
        cover: settings.nzAccCover,
        agreedCover: settings.nzAccAgreedCover ?? undefined,
        workLevyRateExGst: settings.nzAccWorkLevyRate ?? undefined,
        fullTime: settings.nzAccFullTime,
      },
    },
    au: {
      year: auYear,
      employmentIncome: jurisdiction === 'AU' ? employment.grossIncome : 0,
      paygWithheld: jurisdiction === 'AU' ? employment.taxWithheld : 0,
      businessIncome: jurisdiction === 'AU' ? selfEmployedIncome : 0,
      businessExpenses: jurisdiction === 'AU' ? expenseTotals.domesticClaimable : 0,
      depreciation: jurisdiction === 'AU' ? depreciation : 0,
      otherIncome: jurisdiction === 'AU' ? other.gross : 0,
      otherTaxCredits: jurisdiction === 'AU' ? other.credits : 0,
      hasHelpDebt: settings.auHasHelpDebt,
      hasPrivateHospitalCover: settings.auHasPrivateHospitalCover,
    },
    // Already converted into the residence currency by getIncomeForYear, at
    // the rate recorded against each pay period rather than today's rate.
    foreignIncomeInResidenceCurrency: foreign.grossIncome,
    foreignTaxPaidInResidenceCurrency: foreign.taxPaid,
  });

  /**
   * Each country's threshold is tested against supplies made in THAT country,
   * in that country's own currency. Handing it a pooled figure — NZ and AU
   * turnover added together, in mixed cents — could report you over a
   * threshold you are nowhere near, or leave you quiet while you crossed one.
   */
  const gst = checkTurnoverThreshold({
    jurisdiction,
    year: resolvedRange.ratesYear,
    registered: jurisdiction === 'NZ' ? settings.nzGstRegistered : settings.auGstRegistered,
    rollingTwelveMonthTurnover: rollingTurnover[jurisdiction],
  });

  /**
   * The other country's threshold still applies to supplies made there, and
   * crossing it obliges you to register there regardless of where you live.
   */
  const foreignJurisdiction = jurisdiction === 'NZ' ? ('AU' as const) : ('NZ' as const);
  const foreignGst = checkTurnoverThreshold({
    jurisdiction: foreignJurisdiction,
    year: foreignJurisdiction === 'NZ' ? nzYear : auYear,
    registered:
      foreignJurisdiction === 'NZ' ? settings.nzGstRegistered : settings.auGstRegistered,
    rollingTwelveMonthTurnover: rollingTurnover[foreignJurisdiction],
  });

  // Reserve against money received, not money invoiced.
  const receivedExGst =
    invoiceTotals.invoicedTotal > 0
      ? Math.round(
          invoiceTotals.paidTotal *
            (1 - invoiceTotals.gstCollected / invoiceTotals.invoicedTotal),
        )
      : 0;
  const shouldHaveReserved = Math.round(receivedExGst * result.reserve.likely.rate);

  return {
    range: resolvedRange,
    invoices: invoiceTotals,
    expenses: expenseTotals,
    depreciation,
    income,
    employment,
    otherIncome: other,
    foreign,
    turnover: rollingTurnover,
    result,
    gst,
    foreignGst,
    shouldHaveReserved,
  };
}

/**
 * A year label as it appears in a URL, which is to say attacker-controlled.
 *
 * `?year=` went straight into `parseInt` and produced the range
 * `NaN-04-01`; the rates lookup then threw its internal "Available: …"
 * message onto an unstyled 500. A dropdown in the UI is not input
 * validation. Anything that is not `YYYY-YY` with consecutive years is
 * ignored in favour of the current year.
 */
const YEAR_LABEL = /^(\d{4})-(\d{2})$/;

export function isValidYearLabel(year: string): boolean {
  const match = YEAR_LABEL.exec(year);
  if (!match) return false;
  const startYear = Number.parseInt(match[1]!, 10);
  const endTwoDigits = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(startYear) || startYear < 1900 || startYear > 2999) return false;
  return (startYear + 1) % 100 === endTwoDigits;
}
