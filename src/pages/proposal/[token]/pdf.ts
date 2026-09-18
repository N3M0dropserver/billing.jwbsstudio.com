import type { APIRoute } from 'astro';
import { db, files, appUrl } from '~/lib/env';
import { getQuoteByToken } from '~/lib/quotes/service';
import { getSettings } from '~/lib/queries/settings';
import { quoteToPdfData } from '~/lib/quotes/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { brandingFor } from '~/lib/invoices/branding';

export const prerender = false;

/** Public quote PDF. The token is the only credential. */
export const GET: APIRoute = async ({ params }) => {
  const database = db();
  const quote = await getQuoteByToken(database, params.token!);
  if (!quote) return new Response('Quote not found', { status: 404 });

  const settings = await getSettings(database, quote.userId);
  const branding = await brandingFor(database, files(), quote.userId, null);
  const bytes = renderInvoicePdf(
    quoteToPdfData(quote, settings, { viewUrl: `${appUrl()}/proposal/${params.token}` }),
    branding,
  );

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${quote.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
};
