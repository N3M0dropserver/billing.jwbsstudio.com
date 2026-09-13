import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import {
  getInvoice,
  updateInvoice,
  editability,
  EDIT_REFUSAL_MESSAGE,
} from '~/lib/invoices/service';
import { parseLines } from '~/lib/invoices/parse';
import type { GstTreatment } from '~/lib/tax/gst';

export const prerender = false;

/**
 * Edit an invoice.
 *
 * This route is what the invoice editor has always posted to when handed an
 * existing invoice — it simply did not exist, so the edit path was unreachable
 * and a wrong figure could only be corrected with SQL against production.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const allowed = editability(invoice);
  if (!allowed.canEdit) {
    return redirect(
      `/invoices/${invoice.id}?error=${encodeURIComponent(EDIT_REFUSAL_MESSAGE[allowed.reason])}`,
      302,
    );
  }

  const form = await request.formData();
  const settings = await getSettings(database, user.id);

  const lines = parseLines(String(form.get('lines') ?? '[]'));
  if (lines.length === 0) {
    return redirect(`/invoices/${invoice.id}/edit?error=no-lines`, 302);
  }

  const treatmentRaw = String(form.get('gstTreatment') ?? 'auto');
  const rawRate = Number.parseFloat(String(form.get('fxRateToResidence') ?? ''));

  await updateInvoice(database, settings, invoice, {
    clientId: String(form.get('clientId') ?? '') || null,
    issuedOn: String(form.get('issuedOn') ?? '') || undefined,
    dueOn: String(form.get('dueOn') ?? '') || undefined,
    currency: form.get('currency') === 'AUD' ? 'AUD' : 'NZD',
    jurisdiction: form.get('jurisdiction') === 'AU' ? 'AU' : 'NZ',
    gstTreatment: treatmentRaw === 'auto' ? undefined : (treatmentRaw as GstTreatment),
    fxRateToResidence: Number.isFinite(rawRate) && rawRate > 0 ? rawRate : undefined,
    reference: String(form.get('reference') ?? ''),
    notes: String(form.get('notes') ?? ''),
    terms: String(form.get('terms') ?? ''),
    lines,
    finalise: form.get('action') !== 'draft',
  });

  return redirect(`/invoices/${invoice.id}?saved=1`, 302);
};
