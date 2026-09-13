import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getQuote, convertQuoteToInvoice } from '~/lib/quotes/service';

export const prerender = false;

/**
 * Raise the invoice for an accepted quote.
 *
 * Deliberately a decision you make, rather than something the client's
 * acceptance triggers by itself: it consumes an invoice number and starts a
 * payment clock, and neither should happen because somebody clicked a button
 * on a public page.
 */
export const POST: APIRoute = async ({ params, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const quote = await getQuote(database, user.id, params.id!);
  if (!quote) return new Response('Quote not found', { status: 404 });

  const settings = await getSettings(database, user.id);
  const result = await convertQuoteToInvoice(database, settings, quote);

  if (!result.ok) {
    return redirect(`/quotes/${quote.id}?error=${encodeURIComponent(result.reason)}`, 302);
  }

  return redirect(`/invoices/${result.invoiceId}?fromQuote=${encodeURIComponent(quote.number)}`, 302);
};
