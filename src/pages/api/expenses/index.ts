import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { expenses, assets, depreciationEntries } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { parseAmount } from '~/lib/tax/money';
import { netFromGross, gstRateFor } from '~/lib/tax/gst';
import { depreciateYear } from '~/lib/tax/deductions';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';
import { EXPENSE_GUIDANCE } from '~/lib/tax/deductions';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const settings = await getSettings(database, user.id);

  const jurisdiction = form.get('jurisdiction') === 'AU' ? 'AU' : 'NZ';
  const incurredOn = String(form.get('incurredOn') ?? new Date().toISOString().slice(0, 10));
  const taxYear =
    jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${incurredOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${incurredOn}T00:00:00Z`));

  const amountGross = parseAmount(String(form.get('amount') ?? '0'));
  if (amountGross <= 0) return redirect('/tax/expenses/new?error=amount', 302);

  /**
   * An expense in the other country's currency needs a rate to be worth
   * anything in a return kept in the residence currency. Blank means 1, and
   * the dashboard reports how many records are sitting unconverted rather
   * than quietly treating A$ as NZ$.
   */
  // The form has no separate currency field: an expense incurred under NZ
  // rules was paid in NZD, and one under AU rules in AUD. Deriving it keeps
  // the two from ever disagreeing.
  const currency = jurisdiction === 'AU' ? 'AUD' : 'NZD';
  const residenceCurrency = settings.taxResidence === 'NZ' ? 'NZD' : 'AUD';
  const rawRate = Number.parseFloat(String(form.get('fxRateToResidence') ?? ''));
  const fxRateToResidence =
    currency === residenceCurrency ? 1 : Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;

  const registered =
    jurisdiction === 'NZ' ? settings.nzGstRegistered : settings.auGstRegistered;
  const hasGst = registered && form.get('hasGst') !== 'no';

  // Receipts are GST-inclusive, so the net (deductible) figure is extracted
  // rather than added. A non-registered business deducts the whole amount.
  const gstRate = gstRateFor(jurisdiction, taxYear);
  const amountNet = hasGst ? netFromGross(amountGross, gstRate) : amountGross;
  const gstAmount = amountGross - amountNet;

  const category = String(form.get('category') ?? 'other');
  const guidance = EXPENSE_GUIDANCE[category as keyof typeof EXPENSE_GUIDANCE];

  const rawUse = Number.parseFloat(String(form.get('businessUsePercent') ?? '100'));
  const businessUsePercent = Number.isFinite(rawUse)
    ? Math.min(Math.max(rawUse / 100, 0), 1)
    : (guidance?.defaultBusinessUse ?? 1);

  const isCapital = form.get('isCapital') === 'yes';
  const now = new Date().toISOString();
  const expenseId = newId();
  let assetId: string | null = null;

  if (isCapital) {
    // A capital item becomes an asset with its own depreciation schedule.
    // The first year is posted immediately so the deduction shows up now.
    assetId = newId();
    const rate = Number.parseFloat(String(form.get('depreciationRate') ?? '30')) / 100;
    const method = form.get('depreciationMethod') === 'SL' ? 'SL' : 'DV';

    const firstYear = depreciateYear({
      jurisdiction,
      year: taxYear,
      cost: amountNet,
      rate: Number.isFinite(rate) ? rate : 0.3,
      method,
      businessUsePercent,
    });

    await database.batch([
      database.insert(assets).values({
        id: assetId,
        userId: user.id,
        name: String(form.get('description') ?? 'Asset'),
        category,
        acquiredOn: incurredOn,
        cost: amountNet,
        currency: settings.defaultCurrency,
        jurisdiction,
        depreciationRate: Number.isFinite(rate) ? rate : 0.3,
        depreciationMethod: method,
        businessUsePercent,
        accumulatedDepreciation: firstYear.depreciationForYear,
        immediateWriteOff: firstYear.immediateWriteOff,
        notes: firstYear.writeOffReason ?? '',
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(depreciationEntries).values({
        id: newId(),
        assetId,
        taxYear,
        opening: firstYear.openingAdjustedValue,
        depreciation: firstYear.depreciationForYear,
        claimable: firstYear.claimableForYear,
        closing: firstYear.closingAdjustedValue,
        createdAt: now,
      }),
    ] as never);
  }

  await database.insert(expenses).values({
    id: expenseId,
    userId: user.id,
    clientId: String(form.get('clientId') ?? '') || null,
    description: String(form.get('description') ?? '').slice(0, 500),
    vendor: String(form.get('vendor') ?? '').slice(0, 200),
    category,
    incurredOn,
    amountGross,
    gstAmount,
    amountNet,
    currency,
    fxRateToResidence,
    jurisdiction,
    businessUsePercent,
    // A capital item's deduction comes through depreciation, not here, so
    // its claimable amount is zero to avoid double counting.
    claimableAmount: isCapital ? 0 : Math.round(amountNet * businessUsePercent),
    isCapital,
    assetId,
    isBillable: form.get('isBillable') === 'yes',
    notes: String(form.get('notes') ?? ''),
    createdAt: now,
    updatedAt: now,
  });

  return redirect('/tax/expenses?added=1', 302);
};
