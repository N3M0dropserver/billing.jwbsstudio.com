import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { createQuote } from '~/lib/quotes/service';
import { parseLines } from '~/lib/invoices/parse';
import type { GstTreatment } from '~/lib/tax/gst';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const settings = await getSettings(database, user.id);

  const title = String(form.get('title') ?? '').trim().slice(0, 200);
  if (!title) return redirect('/quotes/new?error=title', 302);

  const lines = parseLines(String(form.get('lines') ?? '[]'));
  if (lines.length === 0) return redirect('/quotes/new?error=no-lines', 302);

  const currency = form.get('currency') === 'AUD' ? 'AUD' : 'NZD';
  const residenceCurrency = settings.taxResidence === 'NZ' ? 'NZD' : 'AUD';
  const rawRate = Number.parseFloat(String(form.get('fxRateToResidence') ?? ''));
  const validDays = Number.parseInt(String(form.get('validDays') ?? ''), 10);
  const treatmentRaw = String(form.get('gstTreatment') ?? 'auto');

  const { id } = await createQuote(database, settings, {
    userId: user.id,
    clientId: String(form.get('clientId') ?? '') || null,
    title,
    body: String(form.get('body') ?? '').slice(0, 5000),
    currency,
    jurisdiction: form.get('jurisdiction') === 'AU' ? 'AU' : 'NZ',
    gstTreatment: treatmentRaw === 'auto' ? undefined : (treatmentRaw as GstTreatment),
    fxRateToResidence:
      currency === residenceCurrency ? 1 : Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1,
    reference: String(form.get('reference') ?? ''),
    notes: String(form.get('notes') ?? ''),
    terms: String(form.get('terms') ?? ''),
    validDays: Number.isFinite(validDays) && validDays > 0 ? Math.min(validDays, 365) : undefined,
    lines,
  });

  return redirect(`/quotes/${id}`, 302);
};
