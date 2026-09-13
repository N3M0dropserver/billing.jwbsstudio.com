import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { getInvoice } from '~/lib/invoices/service';
import { invoices } from '~/lib/db/schema';

export const prerender = false;

/** Pause or resume automatic chasing for one invoice — a dispute, a payment plan. */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const form = await request.formData();
  const paused = form.get('paused') === 'yes';

  await database
    .update(invoices)
    .set({ remindersPaused: paused, updatedAt: new Date().toISOString() })
    .where(eq(invoices.id, invoice.id));

  return redirect(`/invoices/${invoice.id}?reminders=${paused ? 'paused' : 'resumed'}`, 302);
};
