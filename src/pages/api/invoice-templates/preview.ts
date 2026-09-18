import type { APIRoute } from 'astro';
import { db, files, appUrl } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getInvoice } from '~/lib/invoices/service';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { sampleInvoice } from '~/lib/invoices/sample';
import { loadLogo } from '~/lib/invoices/branding';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { normalise } from '~/lib/pdf/template';

export const prerender = false;

/**
 * Render a design that has not been saved.
 *
 * This is what makes the designer honest. The preview is not an approximation
 * of the PDF drawn in HTML — it IS the PDF, produced by the same function that
 * produces the one a client receives, so there is no second renderer to drift
 * out of step with the first.
 *
 * `invoiceId` previews against a real invoice; without one, a sample built
 * from the account's own settings.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }

  const database = db();
  const design = normalise(body.design);
  const settings = await getSettings(database, user.id);

  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : '';
  let data = sampleInvoice(settings, appUrl());

  if (invoiceId) {
    const invoice = await getInvoice(database, user.id, invoiceId);
    if (invoice) {
      const payUrl = invoice.publicToken ? `${appUrl()}/pay/${invoice.publicToken}` : undefined;
      data = toPdfData(invoice, settings, { payUrl });
    }
  }

  const bytes = renderInvoicePdf(data, { design, logo: await loadLogo(files(), design) });

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="preview.pdf"',
      // A preview is generated per keystroke-ish; caching it would only ever
      // show a stale design.
      'cache-control': 'private, no-store',
    },
  });
};
