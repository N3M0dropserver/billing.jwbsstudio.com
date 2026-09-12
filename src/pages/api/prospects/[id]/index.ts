import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { clients, prospects } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export const prerender = false;

const STATUSES = ['new', 'qualified', 'contacted', 'responded', 'converted', 'rejected'] as const;

export const POST: APIRoute = async ({ request, params, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const id = String(params.id ?? '');
  const database = db();

  const rows = await database
    .select()
    .from(prospects)
    .where(and(eq(prospects.id, id), eq(prospects.userId, user.id)))
    .limit(1);

  const prospect = rows[0];
  if (!prospect) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const now = new Date().toISOString();

  if (action === 'status') {
    const status = String(form.get('status') ?? '');
    if (!(STATUSES as readonly string[]).includes(status)) {
      return new Response('Unknown status', { status: 400 });
    }
    await database
      .update(prospects)
      .set({ status: status as 'new', updatedAt: now })
      .where(eq(prospects.id, id));
  } else if (action === 'notes') {
    await database
      .update(prospects)
      .set({ notes: String(form.get('notes') ?? '').slice(0, 4000), updatedAt: now })
      .where(eq(prospects.id, id));
  } else if (action === 'convert') {
    // Converting twice would create a second client for the same business.
    if (prospect.convertedClientId) {
      return redirect(`/clients/${prospect.convertedClientId}`, 302);
    }

    const clientId = newId();
    await database.insert(clients).values({
      id: clientId,
      userId: user.id,
      name: prospect.businessName,
      email: prospect.email,
      phone: prospect.phone,
      website: prospect.website,
      country: prospect.country === 'AU' ? 'AU' : 'NZ',
      notes: [prospect.notes, prospect.reviewSummary].filter(Boolean).join('\n\n').slice(0, 4000),
      createdAt: now,
      updatedAt: now,
    });

    await database
      .update(prospects)
      .set({ status: 'converted', convertedClientId: clientId, updatedAt: now })
      .where(eq(prospects.id, id));

    return redirect(`/clients/${clientId}`, 302);
  } else {
    return new Response('Unknown action', { status: 400 });
  }

  return redirect(`/growth/prospects/${id}`, 302);
};
