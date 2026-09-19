/**
 * Renders an invoice to a PDF.
 *
 * Layout notes: an invoice has to survive being printed, forwarded to an
 * accounts department, and read on a phone. So: one page where possible,
 * generous leading, the amount due unmissable, and the payment details in a
 * block someone can copy without squinting.
 *
 * Both IRD and the ATO require specific wording on a tax invoice. The chosen
 * layout emits the right heading and identifiers for the jurisdiction — that
 * part is not a design decision and no template can switch it off. See
 * `documentTitle` and `exportNote` in `./layouts`.
 *
 * WHAT IT LOOKS LIKE is a template: a layout name, a palette, a logo and a
 * few switches (`./template`). The default is the arrangement this system has
 * always produced, so an account that has never opened the designer gets
 * exactly the invoice it got before templates existed.
 *
 * This function is synchronous on purpose. Decoding the logo is not — see
 * `loadLogo` in `~/lib/invoices/branding` — so the caller does that first and
 * passes the result in. That keeps every render path, including the cron
 * sweep, free of a reason to fail.
 */

import { PdfDocument, measureText } from './writer';
import type { PdfImage } from './image';
import type { Cents, Currency } from '~/lib/tax/money';
import { DEFAULT_DESIGN, type InvoiceTemplateDesign } from './template';
import { LAYOUT_RENDERERS, layoutContext } from './layouts';

export interface InvoicePdfData {
  /**
   * What kind of document this is. A quote uses the same layout, the same
   * arithmetic and the same GST engine as an invoice — it differs in what it
   * is called and in what the second date means, and nothing else.
   */
  kind?: 'invoice' | 'quote';
  number: string;
  issuedOn: string;
  /** Payment due, on an invoice. The date a quote lapses, on a quote. */
  dueOn: string;
  currency: Currency;
  jurisdiction: 'NZ' | 'AU';
  gstTreatment: 'standard' | 'zero-rated-export' | 'exempt' | 'not-registered';
  gstLabel: string;
  reference: string;
  notes: string;
  terms: string;

  from: {
    businessName: string;
    legalName: string;
    addressLines: string[];
    email: string;
    phone: string;
    website: string;
    taxNumber: string;
    taxNumberLabel: string;
  };

  to: {
    name: string;
    addressLines: string[];
    email: string;
    taxNumber: string;
  };

  lines: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: Cents;
    lineTotal: Cents;
  }>;

  subtotal: Cents;
  gstAmount: Cents;
  total: Cents;
  amountPaid: Cents;

  bank: {
    accountName: string;
    accountNumber: string;
    bankName: string;
    bsb: string;
    swift: string;
  };

  payUrl?: string;
  footer: string;
}

export interface RenderOptions {
  /** The template to draw with. Omitted means the built-in default. */
  design?: InvoiceTemplateDesign;
  /** A decoded logo, from `loadLogo`. Omitted means no logo is drawn. */
  logo?: PdfImage | null;
}

export function renderInvoicePdf(
  data: InvoicePdfData,
  options: RenderOptions = {},
): Uint8Array {
  const design = options.design ?? DEFAULT_DESIGN;
  const doc = new PdfDocument();

  // Registered before any page exists so the resource dictionary every page
  // gets is complete — pages are written last, in `build`.
  const logo = options.logo ? doc.addImage(options.logo) : null;

  const render = LAYOUT_RENDERERS[design.layout] ?? LAYOUT_RENDERERS.classic;
  render(layoutContext(doc, data, design, logo));

  return doc.build({
    title: `${data.kind === 'quote' ? 'Quote' : 'Invoice'} ${data.number}`,
    author: data.from.businessName,
  });
}

export { measureText };
