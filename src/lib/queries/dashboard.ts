/**
 * Aggregate queries behind the dashboard and the tax page.
 *
 * These do the arithmetic in SQL where it is a plain sum, and in TypeScript
 * where it needs the tax engine. Anything touching rates goes through
 * `src/lib/tax`, never a hardcoded number in a query.
 */

import { and, eq, gte, lte, sql, desc, ne } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
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
import type { Cents, Currency } from '~/lib/tax/money';
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
import { resolveRatesYear } from '~/lib/tax/rates';

export interface TaxYearRange {
  /** The real tax year the date falls in. Always correct, table or no table. */
  year: string;
  startsOn: string;
  endsOn: string;
  jurisdiction: Jurisdiction;
  /**
   * The year whose rate table the figures are computed from. The same as
   * `year` unless no table has been added for it yet.
   */
  ratesYear: string;
  /** True when `ratesYear` is a fallback — last year's rates, this year's income. */
  ratesAreProvisional: boolean;
}

/**
 * The tax year a date falls in, and the rate table to compute it with.
 *
 * The date range is derived from the calendar rather than read off the rate
 * table, so a year with no table still has the right boundaries. Only the
 * RATES fall back, and when they do it is reported rather than assumed.
 */
export function currentTaxYear(jurisdiction: Jurisdiction, now = new Date()): TaxYearRange {
  const year = jurisdiction === 'NZ' ? nzTaxYearFor(now) : auFinancialYearFor(now);
  return taxYearRange(jurisdiction, year);
}

export function taxYearRange(jurisdiction: Jurisdiction, year: string): TaxYearRange {
  const { startsOn, endsOn } = yearRangeFor(jurisdiction, year);
  const resolved = resolveRatesYear(jurisdiction, year);
  return {
    year,
    startsOn,
    endsOn,
    jurisdiction,
    ratesYear: resolved.ratesYear,
    ratesAreProvisional: resolved.provisional,
  };
}

/**
 * What was actually billed in one currency, before any conversion.
 *
 * Kept alongside the converted figures so the dashboard can show "NZ$41,200,
 * including A$6,000 converted at 1.09" rather than a single number whose
 * provenance is invisible.
 */
export interface CurrencySlice {
  currency: Currency;
  invoiced: Cents;
  paid: Cents;
  invoiceCount: number;
}

/**
 * Invoice aggregates for a tax year.
 *
 * Two things every figure here now respects, and did not before:
 *
 *  1. **Currency.** Invoices carry NZD or AUD. Every total used to be a bare
 *     sum of the cents column, so an A$1,000 invoice and a NZ$1,000 invoice
 *     added to "$2,000" and the dashboard stamped the default currency on the
 *     result. Each row is converted through its own stored
 *     `fxRateToResidence` before it is added to anything.
 *  2. **Source.** An invoice records the jurisdiction whose GST rules apply,
 *     which is also where the supply was made. The residence country taxes
 *     both, but only after the foreign slice has been through the foreign tax
 *     credit machinery — so they are counted apart rather than pooled.
 */
export interface InvoiceTotals {
  /** Currency every `Cents` figure on this object is expressed in. */
  residenceCurrency: Currency;

  invoicedTotal: Cents;
  paidTotal: Cents;
  unpaidTotal: Cents;
  overdueTotal: Cents;
  draftTotal: Cents;
  gstCollected: Cents;
  invoiceCount: number;
  paidCount: number;
  overdueCount: number;

  /** Supplies made in the country of residence. */
  domestic: { invoiced: Cents; gstCollected: Cents };
  /** Supplies made in the other country. Taxed at home, credited for tax paid there. */
  foreign: { invoiced: Cents; gstCollected: Cents };

  /** What was billed, per currency, before conversion. */
  byCurrency: CurrencySlice[];
  /**
   * Foreign-currency invoices still sitting at a rate of exactly 1 — i.e.
   * counted at face value. Surfaced rather than silently trusted, because a
   * missing rate understates or overstates income by the whole spread.
   */
  unconvertedForeignCurrencyCount: number;
}

export async function getInvoiceTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
  residenceCurrency: Currency,
): Promise<InvoiceTotals> {
  const today = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      status: invoices.status,
      dueOn: invoices.dueOn,
      gstAmount: invoices.gstAmount,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      currency: invoices.currency,
      jurisdiction: invoices.jurisdiction,
      fxRateToResidence: invoices.fxRateToResidence,
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
    residenceCurrency,
    invoicedTotal: 0,
    paidTotal: 0,
    unpaidTotal: 0,
    overdueTotal: 0,
    draftTotal: 0,
    gstCollected: 0,
    invoiceCount: 0,
    paidCount: 0,
    overdueCount: 0,
    domestic: { invoiced: 0, gstCollected: 0 },
    foreign: { invoiced: 0, gstCollected: 0 },
    byCurrency: [],
    unconvertedForeignCurrencyCount: 0,
  };

  const residenceJurisdiction: Jurisdiction = residenceCurrency === 'NZD' ? 'NZ' : 'AU';
  const perCurrency = new Map<Currency, CurrencySlice>();

  for (const row of rows) {
    const rate = row.currency === residenceCurrency ? 1 : row.fxRateToResidence;
    const convert = (amount: Cents) => toResidenceCurrency(amount, rate);

    const total = convert(row.total);
    const amountPaid = convert(row.amountPaid);
    const gstAmount = convert(row.gstAmount);

    // Track the un-converted figures per currency regardless of status, so
    // the breakdown matches what the invoice list shows.
    const slice = perCurrency.get(row.currency) ?? {
      currency: row.currency,
      invoiced: 0,
      paid: 0,
      invoiceCount: 0,
    };

    if (row.status === 'draft') {
      totals.draftTotal += total;
      continue;
    }

    if (row.currency !== residenceCurrency && row.fxRateToResidence === 1) {
      totals.unconvertedForeignCurrencyCount += 1;
    }

    slice.invoiced += row.total;
    slice.paid += row.amountPaid;
    slice.invoiceCount += 1;
    perCurrency.set(row.currency, slice);

    totals.invoiceCount += 1;
    totals.invoicedTotal += total;
    totals.gstCollected += gstAmount;
    totals.paidTotal += amountPaid;

    const bucket =
      row.jurisdiction === residenceJurisdiction ? totals.domestic : totals.foreign;
    bucket.invoiced += total;
    bucket.gstCollected += gstAmount;

    const outstanding = total - amountPaid;
    if (outstanding > 0 && row.status !== 'written-off') {
      totals.unpaidTotal += outstanding;
      if (row.dueOn < today) {
        totals.overdueTotal += outstanding;
        totals.overdueCount += 1;
      }
    }
    if (row.status === 'paid') totals.paidCount += 1;
  }

  totals.byCurrency = [...perCurrency.values()].sort((a, b) =>
    a.currency === residenceCurrency ? -1 : b.currency === residenceCurrency ? 1 : 0,
  );

  return totals;
}

export interface ExpenseTotals {
  /** Currency every `Cents` figure on this object is expressed in. */
  residenceCurrency: Currency;
  grossTotal: Cents;
  claimableTotal: Cents;
  gstReclaimable: Cents;
  count: number;
  byCategory: Array<{ category: string; claimable: Cents; count: number }>;
  /**
   * Claimable spend split by where it was incurred. A deduction belongs
   * against the income it was incurred to earn, so foreign-jurisdiction
   * costs reduce the foreign slice rather than the domestic one.
   */
  domesticClaimable: Cents;
  foreignClaimable: Cents;
  /**
   * GST/VAT-equivalent paid in the other country. Not reclaimable on a
   * domestic return, so it is reported apart from `gstReclaimable`.
   */
  foreignGstPaid: Cents;
  /** Foreign-currency expenses still counted at face value. */
  unconvertedForeignCurrencyCount: number;
}

export async function getExpenseTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
  residenceCurrency: Currency,
): Promise<ExpenseTotals> {
  const rows = await db
    .select({
      category: expenses.category,
      amountGross: expenses.amountGross,
      gstAmount: expenses.gstAmount,
      claimableAmount: expenses.claimableAmount,
      businessUsePercent: expenses.businessUsePercent,
      currency: expenses.currency,
      jurisdiction: expenses.jurisdiction,
      fxRateToResidence: expenses.fxRateToResidence,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.userId, userId),
        gte(expenses.incurredOn, range.startsOn),
        lte(expenses.incurredOn, range.endsOn),
      ),
    );

  const residenceJurisdiction: Jurisdiction = residenceCurrency === 'NZD' ? 'NZ' : 'AU';
  const byCategory = new Map<string, { claimable: Cents; count: number }>();
  const totals: ExpenseTotals = {
    residenceCurrency,
    grossTotal: 0,
    claimableTotal: 0,
    gstReclaimable: 0,
    count: rows.length,
    byCategory: [],
    domesticClaimable: 0,
    foreignClaimable: 0,
    foreignGstPaid: 0,
    unconvertedForeignCurrencyCount: 0,
  };

  for (const row of rows) {
    const rate = row.currency === residenceCurrency ? 1 : row.fxRateToResidence;
    if (row.currency !== residenceCurrency && row.fxRateToResidence === 1) {
      totals.unconvertedForeignCurrencyCount += 1;
    }

    const amountGross = toResidenceCurrency(row.amountGross, rate);
    const claimableAmount = toResidenceCurrency(row.claimableAmount, rate);
    // Only the business-use share of the GST is reclaimable.
    const gstShare = toResidenceCurrency(
      Math.round(row.gstAmount * row.businessUsePercent),
      rate,
    );
    const isDomestic = row.jurisdiction === residenceJurisdiction;

    totals.grossTotal += amountGross;
    totals.claimableTotal += claimableAmount;
    if (isDomestic) {
      totals.domesticClaimable += claimableAmount;
      totals.gstReclaimable += gstShare;
    } else {
      totals.foreignClaimable += claimableAmount;
      totals.foreignGstPaid += gstShare;
    }

    const entry = byCategory.get(row.category) ?? { claimable: 0, count: 0 };
    entry.claimable += claimableAmount;
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
  residenceCurrency: Currency,
): Promise<CumulativePoint[]> {
  const rows = await db
    .select({
      issuedOn: invoices.issuedOn,
      dueOn: invoices.dueOn,
      paidOn: invoices.paidOn,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      currency: invoices.currency,
      fxRateToResidence: invoices.fxRateToResidence,
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
    // One scale, one currency. Mixing NZD and AUD cents here drew a line that
    // was not to any scale at all.
    const rate = row.currency === residenceCurrency ? 1 : row.fxRateToResidence;
    const total = toResidenceCurrency(row.total, rate);
    const amountPaid = toResidenceCurrency(row.amountPaid, rate);

    invoicedByDate.set(row.issuedOn, (invoicedByDate.get(row.issuedOn) ?? 0) + total);
    if (amountPaid > 0) {
      // Fall back to the due date when no payment date was recorded.
      const when = row.paidOn ?? row.dueOn;
      paidByDate.set(when, (paidByDate.get(when) ?? 0) + amountPaid);
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
  residenceCurrency: Currency,
  limit = 8,
): Promise<ClientRevenue[]> {
  /**
   * Conversion happens inside the SUM rather than after it, so the grouping,
   * the ordering and the LIMIT all see the same converted figure. Ranking
   * clients by an unconverted sum put a client billed in the weaker currency
   * above one billed in the stronger, which is the wrong answer to "who is my
   * biggest client".
   */
  const converted = (column: SQLiteColumn) => sql<number>`coalesce(sum(CAST(round(
    ${column} * (CASE WHEN ${invoices.currency} = ${residenceCurrency}
      THEN 1 ELSE ${invoices.fxRateToResidence} END)
  ) AS INTEGER)), 0)`;

  const rows = await db
    .select({
      clientId: clients.id,
      name: clients.name,
      invoiced: converted(invoices.total),
      paid: converted(invoices.amountPaid),
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
    .orderBy(desc(converted(invoices.total)))
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

/**
 * Rolling 12-month turnover for the GST registration threshold test, split by
 * the jurisdiction of the supply and left in that jurisdiction's OWN currency.
 *
 * Both of those matter and neither used to happen. The NZ$60,000 test is
 * about supplies made in New Zealand; the A$75,000 test is about Australian
 * turnover. Pooling the two — and adding AUD cents to NZD cents while doing
 * it — could report you over a threshold you are nowhere near, or, worse,
 * leave you quiet while you crossed one. Registering late is the expensive
 * direction: GST is payable on supplies made from the date you were required
 * to register, whether or not you had registered.
 *
 * No conversion is applied. A threshold denominated in NZD is tested against
 * NZ supplies, which are already in NZD.
 */
export interface TurnoverByJurisdiction {
  NZ: Cents;
  AU: Cents;
}

export async function getRollingTurnover(
  db: Db,
  userId: string,
): Promise<TurnoverByJurisdiction> {
  const twelveMonthsAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      jurisdiction: invoices.jurisdiction,
      total: sql<number>`coalesce(sum(${invoices.subtotal}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.userId, userId),
        gte(invoices.issuedOn, twelveMonthsAgo),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
      ),
    )
    .groupBy(invoices.jurisdiction);

  const turnover: TurnoverByJurisdiction = { NZ: 0, AU: 0 };
  for (const row of rows) turnover[row.jurisdiction] += row.total;
  return turnover;
}

export interface UpcomingItem {
  kind: 'invoice-due' | 'invoice-overdue';
  label: string;
  date: string;
  amount: Cents;
  /**
   * The invoice's own currency. These are individual documents rather than a
   * total, so each is shown as it was billed — converting them would invent a
   * figure that appears on no invoice.
   */
  currency: Currency;
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
      currency: invoices.currency,
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
    currency: row.currency,
    href: `/invoices/${row.id}`,
  }));
}

/**
 * Total actually banked in the year, and the merchant fees taken out of it,
 * converted into the residence currency at the rate recorded on each payment.
 */
export async function getBankedTotals(
  db: Db,
  userId: string,
  range: TaxYearRange,
  residenceCurrency: Currency,
): Promise<{ received: Cents; fees: Cents }> {
  const converted = (column: SQLiteColumn) => sql<number>`coalesce(sum(CAST(round(
    ${column} * (CASE WHEN ${payments.currency} = ${residenceCurrency}
      THEN 1 ELSE ${payments.fxRateToResidence} END)
  ) AS INTEGER)), 0)`;

  const rows = await db
    .select({
      received: converted(payments.amount),
      fees: converted(payments.fee),
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
