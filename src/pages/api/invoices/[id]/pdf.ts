import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, files, appUrl } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getInvoice } from '~/lib/invoices/service';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { brandingFor } from '~/lib/invoices/branding';
import { invoices } from '~/lib/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const settings = await getSettings(database, user.id);
  const payUrl = invoice.publicToken ? `${appUrl()}/pay/${invoice.publicToken}` : undefined;
  const branding = await brandingFor(database, files(), user.id, invoice.templateId);
  const bytes = renderInvoicePdf(toPdfData(invoice, settings, { payUrl }), branding);

  // Cache in R2 so a re-send and a re-download return the same bytes that
  // were originally issued.
  try {
    const key = `invoices/${user.id}/${invoice.number}.pdf`;
    await files().put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    if (invoice.pdfKey !== key) {
      await database.update(invoices).set({ pdfKey: key }).where(eq(invoices.id, invoice.id));
    }
  } catch {
    // R2 being unavailable must not stop someone downloading their invoice.
  }

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${invoice.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
};
