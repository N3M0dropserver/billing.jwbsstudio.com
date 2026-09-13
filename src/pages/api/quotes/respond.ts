import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { getQuoteByToken, acceptQuote, declineQuote, hasLapsed } from '~/lib/quotes/service';
import { proposals } from '~/lib/db/schema';

export const prerender = false;

/**
 * The client's answer, from the public quote page.
 *
 * Unauthenticated by design — the token is the credential, exactly as it is
 * on the pay page. It can accept or decline and nothing else: it cannot read
 * another quote, cannot change a figure, and cannot raise an invoice.
 */
export const POST: APIRoute = async ({ request, redirect, clientAddress }) => {
  const form = await request.formData();
  const token = String(form.get('token') ?? '');
  const action = String(form.get('action') ?? '');

  if (!token) return new Response('Missing token', { status: 400 });

  const database = db();
  const quote = await getQuoteByToken(database, token);
  if (!quote) return new Response('Quote not found', { status: 404 });

  const back = (query: string) => redirect(`/proposal/${token}?${query}`, 302);

  if (hasLapsed(quote)) {
    return back('error=' + encodeURIComponent('This quote has expired. Ask for a new one.'));
  }

  if (action === 'accept') {
    const name = String(form.get('name') ?? '').trim();
    if (!name) {
      return back('error=' + encodeURIComponent('Please put your name to it.'));
    }

    const result = await acceptQuote(database, quote, { name, ip: clientAddress ?? null });
    if (!result.ok) return back('error=' + encodeURIComponent(result.reason ?? 'Could not accept.'));
    return back('accepted=1');
  }

  if (action === 'decline') {
    if (quote.status === 'accepted') {
      return back('error=' + encodeURIComponent('This quote has already been accepted.'));
    }
    await declineQuote(database, quote, String(form.get('reason') ?? ''));
    return back('declined=1');
  }

  return back('error=' + encodeURIComponent('Unknown action.'));
};
