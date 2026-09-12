import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, bindings } from '~/lib/env';
import { verifyWebhook, extractPayment } from '~/lib/stripe';
import { recordPayment } from '~/lib/invoices/service';
import { invoices } from '~/lib/db/schema';

export const prerender = false;

/**
 * Stripe webhook.
 *
 * Unauthenticated by design — the signature IS the authentication. The raw
 * body must be read as text and passed through untouched, because Stripe
 * signs the exact bytes it sent.
 *
 * Always returns 200 once the signature checks out, even if the invoice has
 * gone: a non-2xx makes Stripe retry forever over something we cannot fix.
 */
export const POST: APIRoute = async ({ request }) => {
  const env = bindings();
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  const verified = await verifyWebhook(env, rawBody, signature);
  if (!verified.ok || !verified.event) {
    return new Response(JSON.stringify({ error: verified.error }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const payment = extractPayment(verified.event);
  if (!payment?.invoiceId || !payment.amount) {
    return Response.json({ received: true, handled: false });
  }

  const database = db();
  const rows = await database
    .select({ id: invoices.id, userId: invoices.userId })
    .from(invoices)
    .where(eq(invoices.id, payment.invoiceId))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) return Response.json({ received: true, handled: false });

  await recordPayment(database, {
    userId: invoice.userId,
    invoiceId: invoice.id,
    amount: payment.amount,
    receivedOn: new Date().toISOString().slice(0, 10),
    method: 'stripe',
    reference: verified.event.id,
    stripeChargeId: payment.chargeId,
    notes: 'Recorded automatically from a Stripe webhook.',
  });

  return Response.json({ received: true, handled: true });
};
