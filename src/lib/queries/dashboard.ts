/**
 * Aggregate queries behind the dashboard and the tax page.
 *
 * These do the arithmetic in SQL where it is a plain sum, and in TypeScript
 * where it needs the tax engine. Anything touching rates goes through
 * `src/lib/tax`, never a hardcoded number in a query.
 */

import { and, eq, gte, lte, sql, desc, ne } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import {
  invoices,
  expenses,
  clients,
  timeEntries,
  payments,
  incomeSources,
  assets,
  depreciationEntries,
} from '~/lib/db/schema';
import type { Cents } from '~/lib/tax/money';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';
import type { Jurisdiction } from '~/lib/tax/rates';
import {
  apportion,
  overlapDays,
  straddles,
  toResidenceCurrency,
  yearRangeFor,
  type DateRange,
} from '~/lib/tax/period';
import { nzRates, auRates } from '~/lib/tax/rates';

export interface TaxYearRange {
  year: string;
  startsOn: string;
  endsOn: string;
  jurisdiction: Jurisdiction;
}

export function currentTaxYear(jurisdiction: Jurisdiction, now = new Date()): TaxYearRange {
  if (jurisdiction === 'NZ') {
    const year = nzTaxYearFor(now);
    const r = nzRates(year);
    return { year, startsOn: r.startsOn, endsOn: r.endsOn, jurisdiction };
  }
  const year = auFinancialYearFor(now);
  const r = auRates(year);
  return { year, startsOn: r.startsOn, endsOn: r.endsOn, jurisdiction };
}

export interface InvoiceTotals {
  invoicedTotal: Cents;
  paidTotal: Cents;
  unpaidTotal: Cents;
  overdueTotal: Cents;
  draftTotal: Cents;
  gstCollected: Cents;
  invoiceCount: number;
  paidCount: number;
  overdueCount: number;
}

export async function getInvoiceTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
): Promise<InvoiceTotals> {
  const today = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      status: invoices.status,
      dueOn: invoices.dueOn,
      gstAmount: invoices.gstAmount,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.userId, userId),
        gte(invoices.issuedOn, range.startsOn),
        lte(invoices.issuedOn, range.endsOn),
        ne(invoices.status, 'void'),
      ),
    );

  const totals: InvoiceTotals = {
    invoicedTotal: 0,
    paidTotal: 0,
    unpaidTotal: 0,
    overdueTotal: 0,
    draftTotal: 0,
    gstCollected: 0,
    invoiceCount: 0,
    paidCount: 0,
    overdueCount: 0,
  };

  for (const row of rows) {
    if (row.status === 'draft') {
      totals.draftTotal += row.total;
      continue;
    }

    totals.invoiceCount += 1;
    totals.invoicedTotal += row.total;
    totals.gstCollected += row.gstAmount;
    totals.paidTotal += row.amountPaid;

    const outstanding = row.total - row.amountPaid;
    if (outstanding > 0 && row.status !== 'written-off') {
      totals.unpaidTotal += outstanding;
      if (row.dueOn < today) {
        totals.overdueTotal += outstanding;
        totals.overdueCount += 1;
      }
    }
    if (row.status === 'paid') totals.paidCount += 1;
  }

  return totals;
}

export interface ExpenseTotals {
  grossTotal: Cents;
  claimableTotal: Cents;
  gstReclaimable: Cents;
  count: number;
  byCategory: Array<{ category: string; claimable: Cents; count: number }>;
}

export async function getExpenseTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
): Promise<ExpenseTotals> {
  const rows = await db
    .select({
      category: expenses.category,
      amountGross: expenses.amountGross,
      gstAmount: expenses.gstAmount,
      claimableAmount: expenses.claimableAmount,
      businessUsePercent: expenses.businessUsePercent,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.userId, userId),
        gte(expenses.incurredOn, range.startsOn),
        lte(expenses.incurredOn, range.endsOn),
      ),
    );

  const byCategory = new Map<string, { claimable: Cents; count: number }>();
  const totals: ExpenseTotals = {
    grossTotal: 0,
    claimableTotal: 0,
    gstReclaimable: 0,
    count: rows.length,
    byCategory: [],
  };

  for (const row of rows) {
    totals.grossTotal += row.amountGross;
    totals.claimableTotal += row.claimableAmount;
    // Only the business-use share of the GST is reclaimable.
    totals.gstReclaimable += Math.round(row.gstAmount * row.businessUsePercent);

    const entry = byCategory.get(row.category) ?? { claimable: 0, count: 0 };
    entry.claimable += row.claimableAmount;
    entry.count += 1;
    byCategory.set(row.category, entry);
  }

  totals.byCategory = [...byCategory.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.claimable - a.claimable);

  return totals;
}

/** Depreciation claimed for the year, from the posted schedule entries. */
export async function getDepreciationForYear(
  db: Db,
  userId: string,
  taxYear: string,
): Promise<Cents> {
  const rows = await db
    .select({ claimable: sql<number>`coalesce(sum(${depreciationEntries.claimable}), 0)` })
    .from(depreciationEntries)
    .innerJoin(assets, eq(depreciationEntries.assetId, assets.id))
    .where(and(eq(assets.userId, userId), eq(depreciationEntries.taxYear, taxYear)));
  return rows[0]?.claimable ?? 0;
}

/**
 * Income recorded outside the invoicing system — a part-time job, interest,
 * dividends, rent — resolved against a tax year window.
 *
 * Three things happen here that did not before, and each of them matters to
 * anyone with work on both sides of the Tasman:
 *
 *  1. **Nothing is filtered out by jurisdiction.** Income sourced in the
 *     country you are NOT resident in is still taxed by the country you ARE
 *     resident in. Dropping it produced a tax estimate that was simply too
 *     low.
 *  2. **Amounts are converted.** A row in AUD is multiplied by the rate
 *     stored on the row before it is added to anything denominated in NZD.
 *  3. **Periods are apportioned.** A pay period is attributed to the years it
 *     overlaps, weighted by days, rather than dumped whole into one label.
 *     The NZ and AU years are three months out of step, so a period that sits
 *     inside one straddles the other.
 */
export interface IncomeSlice {
  /** Converted into the residence currency. */
  grossIncome: Cents;
  taxWithheld: Cents;
  accLevyWithheld: Cents;
  /** Before conversion, for showing the user what they actually entered. */
  grossInSourceCurrency: Cents;
  taxWithheldInSourceCurrency: Cents;
}

export interface IncomeForYear {
  /** Salary or wages sourced in the residence country. */
  domesticEmployment: IncomeSlice;
  /** Salary or wages sourced in the other country. */
  foreignEmployment: IncomeSlice;
  /** Interest, dividends, rent and the like, sourced in the residence country. */
  domesticOther: IncomeSlice;
  /** The same, sourced in the other country. */
  foreignOther: IncomeSlice;
  /** Rows whose period crosses the year boundary and so were split. */
  apportionedRowCount: number;
  /** Rows in a currency other than the residence currency. */
  convertedRowCount: number;
  /** Rows in a foreign currency left at a rate of exactly 1. */
  unconvertedForeignCurrencyRowCount: number;
}

function emptySlice(): IncomeSlice {
  return {
    grossIncome: 0,
    taxWithheld: 0,
    accLevyWithheld: 0,
    grossInSourceCurrency: 0,
    taxWithheldInSourceCurrency: 0,
  };
}

function emptyIncomeForYear(): IncomeForYear {
  return {
    domesticEmployment: emptySlice(),
    foreignEmployment: emptySlice(),
    domesticOther: emptySlice(),
    foreignOther: emptySlice(),
    apportionedRowCount: 0,
    convertedRowCount: 0,
    unconvertedForeignCurrencyRowCount: 0,
  };
}

/**
 * The period a row covers. Rows created before periods existed carry only a
 * year label, so they fall back to the whole of that year in their own
 * jurisdiction's calendar.
 */
function periodFor(row: {
  earnedFrom: string | null;
  earnedTo: string | null;
  taxYear: string;
  jurisdiction: Jurisdiction;
}): DateRange {
  if (row.earnedFrom && row.earnedTo) {
    return { startsOn: row.earnedFrom, endsOn: row.earnedTo };
  }
  if (row.earnedFrom) return { startsOn: row.earnedFrom, endsOn: row.earnedFrom };
  return yearRangeFor(row.jurisdiction, row.taxYear);
}

export async function getIncomeForYear(
  db: Db,
  userId: string,
  range: TaxYearRange,
  residenceCurrency: 'NZD' | 'AUD',
): Promise<IncomeForYear> {
  const rows = await db
    .select({
      kind: incomeSources.kind,
      jurisdiction: incomeSources.jurisdiction,
      taxYear: incomeSources.taxYear,
      earnedFrom: incomeSources.earnedFrom,
      earnedTo: incomeSources.earnedTo,
      grossAmount: incomeSources.grossAmount,
      taxWithheld: incomeSources.taxWithheld,
      accLevyWithheld: incomeSources.accLevyWithheld,
      currency: incomeSources.currency,
      fxRateToResidence: incomeSources.fxRateToResidence,
    })
    .from(incomeSources)
    .where(eq(incomeSources.userId, userId));

  const window: DateRange = { startsOn: range.startsOn, endsOn: range.endsOn };
  const totals = emptyIncomeForYear();

  for (const row of rows) {
    const period = periodFor(row);
    if (overlapDays(period, window) <= 0) continue;

    const gross = apportion(row.grossAmount, period, window);
    const withheld = apportion(row.taxWithheld, period, window);
    const accLevy = apportion(row.accLevyWithheld, period, window);
    const fx = row.fxRateToResidence;

    const isForeign = row.jurisdiction !== range.jurisdiction;
    const slice =
      row.kind === 'employment'
        ? isForeign
          ? totals.foreignEmployment
          : totals.domesticEmployment
        : isForeign
          ? totals.foreignOther
          : totals.domesticOther;

    slice.grossInSourceCurrency += gross;
    slice.taxWithheldInSourceCurrency += withheld;
    slice.grossIncome += toResidenceCurrency(gross, fx);
    slice.taxWithheld += toResidenceCurrency(withheld, fx);
    slice.accLevyWithheld += toResidenceCurrency(accLevy, fx);

    if (straddles(period, window)) totals.apportionedRowCount += 1;
    if (row.currency !== residenceCurrency) {
      totals.convertedRowCount += 1;
      // A foreign-currency row left at 1:1 is being added to the residence
      // figures as though the currencies were at par. Worth saying out loud.
      if (fx === 1) totals.unconvertedForeignCurrencyRowCount += 1;
    }
  }

  return totals;
}

export interface CumulativePoint {
  date: string;
  paid: Cents;
  invoiced: Cents;
  projected: boolean;
}

/**
 * The dashboard's headline chart: cumulative invoiced against cumulative
 * paid. The gap between the two lines IS the money you are owed, drawn to
 * scale rather than stated as a number.
 */
export async function getCumulativeSeries(
  db: Db,
  userId: string,
  range: TaxYearRange,
): Promise<CumulativePoint[]> {
  const rows = await db
    .select({
      issuedOn: invoices.issuedOn,
      dueOn: invoices.dueOn,
      paidOn: invoices.paidOn,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.userId, userId),
        gte(invoices.issuedOn, range.startsOn),
        lte(invoices.issuedOn, range.endsOn),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
      ),
    )
    .orderBy(invoices.issuedOn);

  if (rows.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const invoicedByDate = new Map<string, Cents>();
  const paidByDate = new Map<string, Cents>();

  for (const row of rows) {
    invoicedByDate.set(row.issuedOn, (invoicedByDate.get(row.issuedOn) ?? 0) + row.total);
    if (row.amountPaid > 0) {
      // Fall back to the due date when no payment date was recorded.
      const when = row.paidOn ?? row.dueOn;
      paidByDate.set(when, (paidByDate.get(when) ?? 0) + row.amountPaid);
    }
  }

  const dates = [...new Set([...invoicedByDate.keys(), ...paidByDate.keys()])].sort();

  const points: CumulativePoint[] = [];
  let invoiced = 0;
  let paid = 0;

  for (const date of dates) {
    invoiced += invoicedByDate.get(date) ?? 0;
    paid += paidByDate.get(date) ?? 0;
    points.push({ date, invoiced, paid, projected: date > today });
  }

  return points;
}

export interface ClientRevenue {
  clientId: string;
  name: string;
  invoiced: Cents;
  paid: Cents;
  outstanding: Cents;
  invoiceCount: number;
}

export async function getRevenueByClient(
  db: Db,
  userId: string,
  range: TaxYearRange,
  limit = 8,
): Promise<ClientRevenue[]> {
  const rows = await db
    .select({
      clientId: clients.id,
      name: clients.name,
      invoiced: sql<number>`coalesce(sum(${invoices.total}), 0)`,
      paid: sql<number>`coalesce(sum(${invoices.amountPaid}), 0)`,
      invoiceCount: sql<number>`count(${invoices.id})`,
    })
    .from(invoices)
    .innerJoin(clients, eq(invoices.clientId, clients.id))
    .where(
      and(
        eq(invoices.userId, userId),
        gte(invoices.issuedOn, range.startsOn),
        lte(invoices.issuedOn, range.endsOn),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
      ),
    )
    .groupBy(clients.id, clients.name)
    .orderBy(desc(sql`sum(${invoices.total})`))
    .limit(limit);

  return rows.map((r) => ({
    clientId: r.clientId,
    name: r.name,
    invoiced: r.invoiced,
    paid: r.paid,
    outstanding: r.invoiced - r.paid,
    invoiceCount: r.invoiceCount,
  }));
}

export interface TimeSummary {
  totalMinutes: number;
  billableMinutes: number;
  unbilledMinutes: number;
  unbilledValue: Cents;
}

export async function getTimeSummary(
  db: Db,
  userId: string,
  range: TaxYearRange,
  defaultHourlyRate: Cents,
): Promise<TimeSummary> {
  const rows = await db
    .select({
      minutes: timeEntries.minutes,
      billable: timeEntries.billable,
      billed: timeEntries.billed,
      hourlyRate: timeEntries.hourlyRate,
      clientRate: clients.hourlyRate,
    })
    .from(timeEntries)
    .leftJoin(clients, eq(timeEntries.clientId, clients.id))
    .where(
      and(
        eq(timeEntries.userId, userId),
        gte(timeEntries.startedAt, range.startsOn),
        lte(timeEntries.startedAt, `${range.endsOn}T23:59:59Z`),
      ),
    );

  const summary: TimeSummary = {
    totalMinutes: 0,
    billableMinutes: 0,
    unbilledMinutes: 0,
    unbilledValue: 0,
  };

  for (const row of rows) {
    summary.totalMinutes += row.minutes;
    if (!row.billable) continue;
    summary.billableMinutes += row.minutes;
    if (row.billed) continue;

    summary.unbilledMinutes += row.minutes;
    const rate = row.hourlyRate ?? row.clientRate ?? defaultHourlyRate;
    summary.unbilledValue += Math.round((row.minutes / 60) * rate);
  }

  return summary;
}

/** Rolling 12-month turnover, for the GST registration threshold test. */
export async function getRollingTurnover(db: Db, userId: string): Promise<Cents> {
  const twelveMonthsAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${invoices.subtotal}), 0)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.userId, userId),
        gte(invoices.issuedOn, twelveMonthsAgo),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
      ),
    );
  return rows[0]?.total ?? 0;
}

export interface UpcomingItem {
  kind: 'invoice-due' | 'invoice-overdue';
  label: string;
  date: string;
  amount: Cents;
  href: string;
}

export async function getUpcoming(db: Db, userId: string, limit = 6): Promise<UpcomingItem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      dueOn: invoices.dueOn,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      clientName: clients.name,
    })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(
      and(
        eq(invoices.userId, userId),
        sql`${invoices.status} in ('sent', 'viewed', 'partial', 'overdue')`,
      ),
    )
    .orderBy(invoices.dueOn)
    .limit(limit);

  return rows.map((row) => ({
    kind: row.dueOn < today ? ('invoice-overdue' as const) : ('invoice-due' as const),
    label: `${row.number}${row.clientName ? ` · ${row.clientName}` : ''}`,
    date: row.dueOn,
    amount: row.total - row.amountPaid,
    href: `/invoices/${row.id}`,
  }));
}

/** Total actually banked in the year, and the merchant fees taken out of it. */
export async function getBankedTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
): Promise<{ received: Cents; fees: Cents }> {
  const rows = await db
    .select({
      received: sql<number>`coalesce(sum(${payments.amount}), 0)`,
      fees: sql<number>`coalesce(sum(${payments.fee}), 0)`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.userId, userId),
        gte(payments.receivedOn, range.startsOn),
        lte(payments.receivedOn, range.endsOn),
      ),
    );
  return { received: rows[0]?.received ?? 0, fees: rows[0]?.fees ?? 0 };
}
