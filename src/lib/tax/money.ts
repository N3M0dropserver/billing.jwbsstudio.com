/**
 * Money is represented everywhere in this codebase as an integer number of
 * cents. Never use floats for currency: 0.1 + 0.2 !== 0.3, and tax figures
 * that are a cent out are tax figures that get questioned.
 */

export type Cents = number;
export type Currency = 'NZD' | 'AUD';

/** Parse a user-entered amount ("1,234.56", "$1234.56", "1234") into cents. */
export function parseAmount(input: string | number | null | undefined): Cents {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** Convert cents to a plain number of dollars (for charts, never for maths). */
export function toDollars(cents: Cents): number {
  return cents / 100;
}

export function fromDollars(dollars: number): Cents {
  return Math.round(dollars * 100);
}

/**
 * Multiply cents by a rate, rounding half away from zero.
 * Tax authorities round to the cent; banker's rounding is not used here.
 */
export function applyRate(cents: Cents, rate: number): Cents {
  const raw = cents * rate;
  return raw < 0 ? -Math.round(-raw) : Math.round(raw);
}

/** Clamp to zero — tax and levy amounts are never negative. */
export function atLeastZero(cents: Cents): Cents {
  return cents > 0 ? cents : 0;
}

export function sum(values: Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(currency: Currency, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = currency + JSON.stringify(opts);
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-NZ', { style: 'currency', currency, ...opts });
    FORMATTERS.set(key, f);
  }
  return f;
}

/** "$1,234.56" */
export function formatMoney(cents: Cents, currency: Currency = 'NZD'): string {
  return formatter(currency, {}).format(cents / 100);
}

/** "$1,235" — for dashboard tiles where cents are noise. */
export function formatMoneyShort(cents: Cents, currency: Currency = 'NZD'): string {
  return formatter(currency, { maximumFractionDigits: 0 }).format(cents / 100);
}

/** "NZ$1,234.56" — where the jurisdiction matters, e.g. on invoices. */
export function formatMoneyWithCode(cents: Cents, currency: Currency): string {
  return `${currency === 'NZD' ? 'NZ' : 'AU'}$${(cents / 100).toLocaleString('en-NZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(rate: number, dp = 1): string {
  return `${(rate * 100).toFixed(dp).replace(/\.0$/, '')}%`;
}
