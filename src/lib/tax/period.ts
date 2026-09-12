/**
 * Attributing income earned over a PERIOD to a TAX YEAR.
 *
 * The two countries' years do not line up. New Zealand runs 1 April to
 * 31 March; Australia runs 1 July to 30 June. Anyone with work on both sides
 * of the Tasman therefore has pay periods that sit inside one country's year
 * and straddle the other's — a fortnight ending 4 April is in the AU year it
 * started in and in the *following* NZ year for most of its days.
 *
 * Recording income against a bare year label cannot express that, so income
 * carries the period it was earned over and is apportioned across the years
 * it overlaps, weighted by days. Day-weighting is the convention both revenue
 * authorities accept for apportioning a single amount across a boundary, and
 * it is exact for the common case of a period that falls wholly inside one
 * year.
 *
 * All dates are inclusive ISO `YYYY-MM-DD` strings, which is what the rest of
 * the codebase stores and what sorts correctly as text.
 */

import type { Cents } from './money';

export interface DateRange {
  /** Inclusive ISO date. */
  startsOn: string;
  /** Inclusive ISO date. */
  endsOn: string;
}

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** Days in an inclusive range: 1 April to 1 April is one day, not zero. */
export function daysInclusive(range: DateRange): number {
  const from = toUtc(range.startsOn);
  const to = toUtc(range.endsOn);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / DAY_MS) + 1;
}

/** Days the two inclusive ranges have in common. Zero when they never meet. */
export function overlapDays(a: DateRange, b: DateRange): number {
  const startsOn = a.startsOn > b.startsOn ? a.startsOn : b.startsOn;
  const endsOn = a.endsOn < b.endsOn ? a.endsOn : b.endsOn;
  if (startsOn > endsOn) return 0;
  return daysInclusive({ startsOn, endsOn });
}

/**
 * The share of `amount`, earned evenly over `earned`, that falls inside
 * `window`.
 *
 * A period wholly inside the window returns the whole amount with no
 * rounding, so the overwhelmingly common case is exact rather than merely
 * close.
 */
export function apportion(amount: Cents, earned: DateRange, window: DateRange): Cents {
  const total = daysInclusive(earned);
  if (total <= 0) return 0;
  const inside = overlapDays(earned, window);
  if (inside <= 0) return 0;
  if (inside >= total) return amount;
  return Math.round((amount * inside) / total);
}

/** Whether a period crosses either end of the window rather than sitting inside it. */
export function straddles(earned: DateRange, window: DateRange): boolean {
  const inside = overlapDays(earned, window);
  return inside > 0 && inside < daysInclusive(earned);
}

/** The NZ tax year range (1 April – 31 March) for a label like "2026-27". */
export function nzYearRange(year: string): DateRange {
  const startYear = Number.parseInt(year.slice(0, 4), 10);
  return { startsOn: `${startYear}-04-01`, endsOn: `${startYear + 1}-03-31` };
}

/** The AU financial year range (1 July – 30 June) for a label like "2026-27". */
export function auYearRange(year: string): DateRange {
  const startYear = Number.parseInt(year.slice(0, 4), 10);
  return { startsOn: `${startYear}-07-01`, endsOn: `${startYear + 1}-06-30` };
}

export function yearRangeFor(jurisdiction: 'NZ' | 'AU', year: string): DateRange {
  return jurisdiction === 'NZ' ? nzYearRange(year) : auYearRange(year);
}

/**
 * Convert an amount in a source currency into the tax-residence currency.
 *
 * The rate is stored on the record rather than looked up now, because the
 * rate that applied when the money was earned is the one the return uses.
 */
export function toResidenceCurrency(amount: Cents, fxRateToResidence: number): Cents {
  if (!Number.isFinite(fxRateToResidence) || fxRateToResidence <= 0) return amount;
  const raw = amount * fxRateToResidence;
  return raw < 0 ? -Math.round(-raw) : Math.round(raw);
}
