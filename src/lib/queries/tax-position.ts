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
import type { Cents } from '~/lib/tax/money';
import {
  currentTaxYear,
  getInvoiceTotals,
  getExpenseTotals,
  getDepreciationForYear,
  getEmploymentIncome,
  getOtherIncome,
  getRollingTurnover,
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
  employment: { grossIncome: Cents; taxWithheld: Cents; accLevyWithheld: Cents };
  otherIncome: { gross: Cents; credits: Cents };
  result: CombinedResult;
  gst: TurnoverCheck;
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
  const resolvedRange = options.year
    ? resolveRange(jurisdiction, options.year)
    : currentTaxYear(jurisdiction, now);

  const userId = settings.userId;

  const [invoiceTotals, expenseTotals, depreciation, employment, other, rollingTurnover] =
    await Promise.all([
      getInvoiceTotals(db, userId, resolvedRange),
      getExpenseTotals(db, userId, resolvedRange),
      getDepreciationForYear(db, userId, resolvedRange.year),
      getEmploymentIncome(db, userId, resolvedRange.year, jurisdiction),
      getOtherIncome(db, userId, resolvedRange.year, jurisdiction),
      getRollingTurnover(db, userId),
    ]);

  // The self-employed income figure is GST-exclusive: GST collected is not
  // your income, it is the government's money passing through your account.
  const selfEmployedIncome = invoiceTotals.invoicedTotal - invoiceTotals.gstCollected;

  const nzYear = jurisdiction === 'NZ' ? resolvedRange.year : nzTaxYearFor(now);
  const auYear = jurisdiction === 'AU' ? resolvedRange.year : auFinancialYearFor(now);

  const result = calculateCombined({
    residence: jurisdiction,
    nz: {
      year: nzYear,
      employmentIncome: jurisdiction === 'NZ' ? employment.grossIncome : 0,
      payeWithheld: jurisdiction === 'NZ' ? employment.taxWithheld : 0,
      accEarnerLevyWithheld: employment.accLevyWithheld,
      selfEmployedIncome: jurisdiction === 'NZ' ? selfEmployedIncome : 0,
      businessExpenses: jurisdiction === 'NZ' ? expenseTotals.claimableTotal : 0,
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
      businessExpenses: jurisdiction === 'AU' ? expenseTotals.claimableTotal : 0,
      depreciation: jurisdiction === 'AU' ? depreciation : 0,
      otherIncome: jurisdiction === 'AU' ? other.gross : 0,
      otherTaxCredits: jurisdiction === 'AU' ? other.credits : 0,
      hasHelpDebt: settings.auHasHelpDebt,
      hasPrivateHospitalCover: settings.auHasPrivateHospitalCover,
    },
  });

  const gst = checkTurnoverThreshold({
    jurisdiction,
    year: resolvedRange.year,
    registered: jurisdiction === 'NZ' ? settings.nzGstRegistered : settings.auGstRegistered,
    rollingTwelveMonthTurnover: rollingTurnover,
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
    employment,
    otherIncome: other,
    result,
    gst,
    shouldHaveReserved,
  };
}

function resolveRange(
  jurisdiction: 'NZ' | 'AU',
  year: string,
): TaxYearRange {
  const startYear = Number.parseInt(year.slice(0, 4), 10);
  if (jurisdiction === 'NZ') {
    return {
      year,
      startsOn: `${startYear}-04-01`,
      endsOn: `${startYear + 1}-03-31`,
      jurisdiction,
    };
  }
  return {
    year,
    startsOn: `${startYear}-07-01`,
    endsOn: `${startYear + 1}-06-30`,
    jurisdiction,
  };
}
