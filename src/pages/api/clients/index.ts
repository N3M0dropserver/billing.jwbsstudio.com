import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { clients } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { parseAmount } from '~/lib/tax/money';

export const prerender = false;

const STATUSES = new Set(['lead', 'active', 'dormant', 'archived']);
const TREATMENTS = new Set(['auto', 'standard', 'zero-rated-export', 'exempt']);

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect('/clients/new?error=name', 302);

  const status = String(form.get('status') ?? 'active');
  const treatment = String(form.get('gstTreatment') ?? 'auto');
  const termsRaw = String(form.get('paymentTermsDays') ?? '').trim();
  const rateRaw = String(form.get('hourlyRate') ?? '').trim();

  const id = newId();
  const now = new Date().toISOString();

  await db().insert(clients).values({
    id,
    userId: user.id,
    name: name.slice(0, 200),
    legalName: String(form.get('legalName') ?? '').slice(0, 200),
    email: String(form.get('email') ?? '').trim().slice(0, 320),
    phone: String(form.get('phone') ?? '').slice(0, 50),
    website: String(form.get('website') ?? '').slice(0, 500),
    addressLine1: String(form.get('addressLine1') ?? '').slice(0, 200),
    addressLine2: String(form.get('addressLine2') ?? '').slice(0, 200),
    city: String(form.get('city') ?? '').slice(0, 100),
    postcode: String(form.get('postcode') ?? '').slice(0, 20),
    country: String(form.get('country') ?? 'NZ').slice(0, 10),
    currency: form.get('currency') === 'AUD' ? 'AUD' : 'NZD',
    taxNumber: String(form.get('taxNumber') ?? '').slice(0, 50),
    gstTreatment: (TREATMENTS.has(treatment) ? treatment : 'auto') as 'auto',
    hourlyRate: rateRaw ? parseAmount(rateRaw) : null,
    paymentTermsDays: termsRaw ? Number.parseInt(termsRaw, 10) || null : null,
    status: (STATUSES.has(status) ? status : 'active') as 'active',
    source: String(form.get('source') ?? ''),
    notes: String(form.get('notes') ?? ''),
    tags: '[]',
    createdAt: now,
    updatedAt: now,
  });

  return redirect(`/clients/${id}`, 302);
};
