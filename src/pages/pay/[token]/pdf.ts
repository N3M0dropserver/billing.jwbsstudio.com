import type { APIRoute } from 'astro';
import { db, appUrl } from '~/lib/env';
import { getInvoiceByToken } from '~/lib/invoices/service';
import { getSettings } from '~/lib/queries/settings';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';

export const prerender = false;

/** Public PDF download. The token is the only credential. */
export const GET: APIRoute = async ({ params }) => {
  const database = db();
  const invoice = await getInvoiceByToken(database, params.token!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const settings = await getSettings(database, invoice.userId);
  const bytes = renderInvoicePdf(
    toPdfData(invoice, settings, { payUrl: `${appUrl()}/pay/${params.token}` }),
  );

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${invoice.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
};
