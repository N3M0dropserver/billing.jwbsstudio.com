import type { APIRoute } from 'astro';
import { db, files, appUrl } from '~/lib/env';
import { getInvoiceByToken } from '~/lib/invoices/service';
import { getSettings } from '~/lib/queries/settings';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { brandingFor } from '~/lib/invoices/branding';
import { isNewOccurrence, recordInvoiceEvent } from '~/lib/activity/events';
import { lastEventAt } from '~/lib/activity/timeline';

export const prerender = false;

/** Public PDF download. The token is the only credential. */
export const GET: APIRoute = async ({ params, request }) => {
  const database = db();
  const invoice = await getInvoiceByToken(database, params.token!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  // Someone downloading the PDF is the strongest engagement signal there is —
  // it is deliberate, and it usually means the invoice is on its way to
  // whoever actually pays it. Logged best effort: the download comes first.
  try {
    const previous = await lastEventAt(database, invoice.id, 'pdf-downloaded');
    if (isNewOccurrence(previous)) {
      await recordInvoiceEvent(database, {
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        type: 'pdf-downloaded',
        actor: 'client',
        ipAddress: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      });
    }
  } catch (error) {
    console.error(`[activity] could not record a PDF download: ${String(error)}`);
  }

  const settings = await getSettings(database, invoice.userId);
  const branding = await brandingFor(database, files(), invoice.userId, invoice.templateId);
  const bytes = renderInvoicePdf(
    toPdfData(invoice, settings, { payUrl: `${appUrl()}/pay/${params.token}` }),
    branding,
  );

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${invoice.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
};
