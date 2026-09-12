import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, appUrl, bindings } from '~/lib/env';
import { getInvoiceByToken } from '~/lib/invoices/service';
import { createCheckoutSession } from '~/lib/stripe';
import { invoices } from '~/lib/db/schema';

export const prerender = false;

/** Starts a card payment from the public invoice page. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const token = String(form.get('token') ?? '');
  if (!token) return new Response('Missing token', { status: 400 });

  const database = db();
  const invoice = await getInvoiceByToken(database, token);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const outstanding = invoice.total - invoice.amountPaid;
  if (outstanding <= 0) return redirect(`/pay/${token}`, 302);

  const base = appUrl();
  const session = await createCheckoutSession(bindings(), {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: outstanding,
    currency: invoice.currency,
    clientEmail: invoice.client?.email || undefined,
    successUrl: `${base}/pay/${token}?paid=1`,
    cancelUrl: `${base}/pay/${token}`,
  });

  if (!session.ok || !session.url) {
    return redirect(`/pay/${token}?error=${encodeURIComponent(session.error ?? 'stripe')}`, 302);
  }

  await database
    .update(invoices)
    .set({ stripePaymentLinkUrl: session.url, updatedAt: new Date().toISOString() })
    .where(eq(invoices.id, invoice.id));

  return redirect(session.url, 303);
};
