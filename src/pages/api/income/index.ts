/**
 * Recording income that never passes through an invoice — a part-time job
 * most of all, but also interest, dividends or rent.
 *
 * The three fields that earn their keep here are the PERIOD, the CURRENCY
 * and the RATE. A pay period is what lets the same fortnight of work be
 * attributed correctly to two tax years that are three months out of step;
 * the currency and rate are what stop AUD being added to NZD as though they
 * were the same money.
 */

import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { incomeSources } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { parseAmount } from '~/lib/tax/money';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';

export const prerender = false;

const KINDS = ['employment', 'interest', 'dividends', 'rental', 'foreign', 'other'] as const;
type Kind = (typeof KINDS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(reason: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/tax/income?error=${reason}` } });
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();

  if (form.get('_action') === 'delete') {
    const id = String(form.get('id') ?? '');
    if (!id) return fail('missing');
    await database
      .delete(incomeSources)
      .where(and(eq(incomeSources.id, id), eq(incomeSources.userId, user.id)));
    return redirect('/tax/income?deleted=1', 302);
  }

  const settings = await getSettings(database, user.id);

  const rawKind = String(form.get('kind') ?? 'employment');
  const kind: Kind = (KINDS as readonly string[]).includes(rawKind) ? (rawKind as Kind) : 'other';
  const jurisdiction = form.get('jurisdiction') === 'AU' ? 'AU' : 'NZ';

  const earnedFrom = String(form.get('earnedFrom') ?? '');
  const earnedTo = String(form.get('earnedTo') ?? '');
  if (!ISO_DATE.test(earnedFrom) || !ISO_DATE.test(earnedTo)) return fail('period');
  if (earnedTo < earnedFrom) return fail('period-order');

  const grossAmount = parseAmount(String(form.get('grossAmount') ?? '0'));
  if (grossAmount <= 0) return fail('amount');

  const taxWithheld = parseAmount(String(form.get('taxWithheld') ?? '0'));
  if (taxWithheld > grossAmount) return fail('withheld');

  // ACC earner levy only ever comes out of New Zealand salary or wages.
  const accLevyWithheld =
    jurisdiction === 'NZ' && kind === 'employment'
      ? parseAmount(String(form.get('accLevyWithheld') ?? '0'))
      : 0;

  const currency = form.get('currency') === 'AUD' ? 'AUD' : 'NZD';
  // Tax residence, not the invoicing default: the figure this converts into is
  // the one the tax engine works in.
  const residenceCurrency = settings.taxResidence === 'NZ' ? 'NZD' : 'AUD';

  // Same currency either side means there is nothing to convert. Different
  // currencies mean the rate matters, and a rate of 1 between NZD and AUD is
  // always wrong, so it is rejected rather than quietly believed.
  let fxRateToResidence = 1;
  if (currency !== residenceCurrency) {
    const raw = Number.parseFloat(String(form.get('fxRateToResidence') ?? ''));
    if (!Number.isFinite(raw) || raw <= 0) return fail('fx');
    fxRateToResidence = raw;
  }

  // The year label is derived from the start of the period in the income's
  // OWN jurisdiction. It is only a label — attribution to a tax year is done
  // from the period itself, so a period that straddles a year boundary is
  // split rather than misfiled.
  const from = new Date(`${earnedFrom}T00:00:00Z`);
  const taxYear = jurisdiction === 'NZ' ? nzTaxYearFor(from) : auFinancialYearFor(from);

  const now = new Date().toISOString();
  await database.insert(incomeSources).values({
    id: newId(),
    userId: user.id,
    taxYear,
    jurisdiction,
    kind,
    label: String(form.get('label') ?? '').slice(0, 200) || 'Income',
    earnedFrom,
    earnedTo,
    grossAmount,
    taxWithheld,
    accLevyWithheld,
    currency,
    fxRateToResidence,
    notes: String(form.get('notes') ?? '').slice(0, 1000),
    createdAt: now,
    updatedAt: now,
  });

  return redirect('/tax/income?added=1', 302);
};
