/**
 * Fetching and decoding the logo a template points at.
 *
 * Separate from the renderer because it is the only async part of drawing an
 * invoice, and `renderInvoicePdf` is deliberately not. Every caller — the
 * download, the public pay page, the send, the overnight sweep — already
 * awaits R2 and the database, so this costs them nothing and keeps the
 * renderer a pure function of its inputs.
 *
 * Nothing here throws. A logo that will not load is an invoice without a logo,
 * not an invoice that failed to send.
 */

import type { Db } from '~/lib/db';
import type { PdfImage } from '~/lib/pdf/image';
import { decodeImage } from '~/lib/pdf/image';
import type { InvoiceTemplateDesign } from '~/lib/pdf/template';
import type { RenderOptions } from '~/lib/pdf/invoice';
import { designFor } from '~/lib/queries/invoice-templates';

/** The one R2 prefix a template's logo may live under. */
export const LOGO_PREFIX = 'invoice-assets/';

/**
 * Cap on what will be pulled into memory and decoded.
 *
 * A PNG with alpha is decoded pixel by pixel, so this is also a bound on the
 * work a single render can be made to do.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function loadLogo(
  bucket: R2Bucket,
  design: InvoiceTemplateDesign,
): Promise<PdfImage | null> {
  const key = design.logo.key;

  // `normalise` already confines the key to this prefix; checked again here
  // because this function is what actually reads the bucket, and the bucket
  // also holds every invoice PDF ever issued.
  if (!key || !key.startsWith(LOGO_PREFIX) || key.includes('..')) return null;

  try {
    const object = await bucket.get(key);
    if (!object) return null;
    if (object.size > MAX_LOGO_BYTES) return null;

    return await decodeImage(new Uint8Array(await object.arrayBuffer()));
  } catch (error) {
    // Worth a line in the log: a logo that silently stopped appearing on
    // invoices is exactly the kind of thing nobody notices for months.
    console.error(`[branding] could not load logo ${key}: ${String(error)}`);
    return null;
  }
}

/**
 * Everything `renderInvoicePdf` needs beyond the invoice itself.
 *
 * One call, because there are six places that render a PDF — download, public
 * download, send, quote send, public quote, and the overnight sweep — and a
 * feature that only half of them honoured would mean the invoice a client is
 * emailed does not match the one they download.
 */
export async function brandingFor(
  db: Db,
  bucket: R2Bucket,
  userId: string,
  templateId: string | null,
): Promise<RenderOptions> {
  const design = await designFor(db, userId, templateId);
  return { design, logo: await loadLogo(bucket, design) };
}
