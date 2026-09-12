import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { settings } from '~/lib/db/schema';
import { parseAmount } from '~/lib/tax/money';

export const prerender = false;

/** Percentage input ("0.66", "33") to a decimal rate, or null when blank. */
function parseRate(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed / 100, 0), 1);
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const current = await getSettings(database, user.id);

  const text = (key: string, max = 300) => String(form.get(key) ?? '').slice(0, max);
  const flag = (key: string) => form.get(key) === 'yes';

  const nextNumber = Number.parseInt(String(form.get('invoiceNextNumber') ?? ''), 10);
  const termsDays = Number.parseInt(String(form.get('defaultPaymentTermsDays') ?? ''), 10);
  const agreedCoverRaw = String(form.get('nzAccAgreedCover') ?? '').trim();

  await database
    .update(settings)
    .set({
      businessName: text('businessName'),
      legalName: text('legalName'),
      addressLine1: text('addressLine1'),
      addressLine2: text('addressLine2'),
      city: text('city', 100),
      postcode: text('postcode', 20),
      email: text('email', 320),
      phone: text('phone', 50),
      website: text('website', 500),

      taxResidence: form.get('taxResidence') === 'AU' ? 'AU' : 'NZ',

      nzIrdNumber: text('nzIrdNumber', 50),
      nzGstRegistered: flag('nzGstRegistered'),
      nzGstNumber: text('nzGstNumber', 50),
      nzGstFilingFrequency: (['monthly', 'two-monthly', 'six-monthly'].includes(
        String(form.get('nzGstFilingFrequency')),
      )
        ? String(form.get('nzGstFilingFrequency'))
        : 'two-monthly') as 'two-monthly',
      nzHasStudentLoan: flag('nzHasStudentLoan'),
      nzAccCover: form.get('nzAccCover') === 'CoverPlusExtra' ? 'CoverPlusExtra' : 'CoverPlus',
      nzAccAgreedCover: agreedCoverRaw ? parseAmount(agreedCoverRaw) : null,
      nzAccWorkLevyRate: parseRate(String(form.get('nzAccWorkLevyRate') ?? '')),
      nzAccFullTime: flag('nzAccFullTime'),

      auAbn: text('auAbn', 20),
      auGstRegistered: flag('auGstRegistered'),
      auBasFrequency: (['monthly', 'quarterly', 'annual'].includes(String(form.get('auBasFrequency')))
        ? String(form.get('auBasFrequency'))
        : 'quarterly') as 'quarterly',
      auHasHelpDebt: flag('auHasHelpDebt'),
      auHasPrivateHospitalCover: flag('auHasPrivateHospitalCover'),

      defaultCurrency: form.get('defaultCurrency') === 'AUD' ? 'AUD' : 'NZD',
      defaultPaymentTermsDays: Number.isFinite(termsDays) && termsDays >= 0 ? termsDays : 14,
      defaultHourlyRate: parseAmount(String(form.get('defaultHourlyRate') ?? '0')),
      invoiceNumberPrefix: text('invoiceNumberPrefix', 20) || 'INV-',
      // Never allow the counter to go backwards — that would risk reusing a
      // number that is already on an issued invoice.
      invoiceNextNumber:
        Number.isFinite(nextNumber) && nextNumber >= current.invoiceNextNumber
          ? nextNumber
          : current.invoiceNextNumber,
      invoiceFooter: text('invoiceFooter', 1000),

      bankAccountName: text('bankAccountName', 100),
      bankAccountNumber: text('bankAccountNumber', 50),
      bankName: text('bankName', 100),
      bankBsb: text('bankBsb', 20),
      bankSwift: text('bankSwift', 20),

      stripeEnabled: flag('stripeEnabled'),
      taxReserveRate: parseRate(String(form.get('taxReserveRate') ?? '')) ?? current.taxReserveRate,

      updatedAt: new Date().toISOString(),
    })
    .where(eq(settings.id, current.id));

  return redirect('/settings?saved=1', 302);
};
