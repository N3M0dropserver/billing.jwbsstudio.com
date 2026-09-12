import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { createInvoice } from '~/lib/invoices/service';
import type { GstTreatment } from '~/lib/tax/gst';

export const prerender = false;

interface RawLine {
  description?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  taxable?: unknown;
}

/**
 * The editor posts lines as a JSON blob in a hidden field, so it must be
 * treated as untrusted: every field is coerced and clamped here, and the
 * totals are recomputed server-side regardless of what the client displayed.
 */
function parseLines(raw: string): Array<{
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxable: boolean;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const units = new Set(['hours', 'days', 'fixed', 'items']);

  return parsed.slice(0, 100).map((entry: RawLine) => {
    const quantity = Number(entry.quantity);
    const unitPrice = Number(entry.unitPrice);
    const unit = String(entry.unit ?? 'hours');
    return {
      description: String(entry.description ?? '').slice(0, 500),
      quantity: Number.isFinite(quantity) ? Math.round(quantity) : 0,
      unit: units.has(unit) ? unit : 'hours',
      unitPrice: Number.isFinite(unitPrice) ? Math.round(unitPrice) : 0,
      taxable: entry.taxable !== false,
    };
  });
}

function parseIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, 500) : [];
  } catch {
    return [];
  }
}

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
    isManualEntry: clientId === null,
    status: form.get('action') === 'draft' ? 'draft' : 'sent',
    timeEntryIds: parseIds(String(form.get('timeEntryIds') ?? '[]')),
  });

  return redirect(`/invoices/${id}`, 302);
};
