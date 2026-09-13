import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { createInvoice } from '~/lib/invoices/service';
import { parseLines, parseIds } from '~/lib/invoices/parse';
import type { GstTreatment } from '~/lib/tax/gst';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const settings = await getSettings(database, user.id);

  const lines = parseLines(String(form.get('lines') ?? '[]'));
  if (lines.length === 0) {
    return redirect('/invoices/new?error=no-lines', 302);
  }

  const clientId = String(form.get('clientId') ?? '') || null;
  const jurisdiction = form.get('jurisdiction') === 'AU' ? 'AU' : 'NZ';
  const currency = form.get('currency') === 'AUD' ? 'AUD' : 'NZD';
  const treatmentRaw = String(form.get('gstTreatment') ?? 'auto');
  const treatment =
    treatmentRaw === 'auto' ? undefined : (treatmentRaw as GstTreatment);

  const issuedOn = String(form.get('issuedOn') ?? new Date().toISOString().slice(0, 10));
  const dueOn = String(form.get('dueOn') ?? '') || undefined;

  /**
   * An invoice in a currency other than the tax-residence currency needs a
   * rate, or it is counted at face value in every total that follows. A blank
   * or nonsensical entry becomes 1 and is reported as unconverted on the
   * dashboard rather than quietly trusted.
   */
  const residenceCurrency = settings.taxResidence === 'NZ' ? 'NZD' : 'AUD';
  const rawRate = Number.parseFloat(String(form.get('fxRateToResidence') ?? ''));
  const fxRateToResidence =
    currency === residenceCurrency ? 1 : Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;

  const { id } = await createInvoice(database, settings, {
    userId: user.id,
    clientId,
    issuedOn,
    dueOn,
    currency,
    jurisdiction,
    gstTreatment: treatment,
    reference: String(form.get('reference') ?? ''),
    notes: String(form.get('notes') ?? ''),
    terms: String(form.get('terms') ?? ''),
    lines,
    fxRateToResidence,
    isManualEntry: clientId === null,
    status: form.get('action') === 'draft' ? 'draft' : 'sent',
    timeEntryIds: parseIds(String(form.get('timeEntryIds') ?? '[]')),
  });

  return redirect(`/invoices/${id}`, 302);
};
