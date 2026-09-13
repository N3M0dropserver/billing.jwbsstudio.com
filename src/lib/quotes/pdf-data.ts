import type { QuoteWithLines } from './service';
import type { Settings } from '~/lib/db/schema';
import type { InvoicePdfData } from '~/lib/pdf/invoice';
import { calculateGst } from '~/lib/tax/gst';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';

/**
 * Map a stored quote onto the invoice PDF shape.
 *
 * Same layout, same arithmetic, same writer — `kind: 'quote'` is what turns
 * "TAX INVOICE" into "QUOTE" and "Due" into "Valid until". A quote is not a
 * tax invoice and must not look like one.
 */
export function quoteToPdfData(
  quote: QuoteWithLines,
  settings: Settings,
  options: { viewUrl?: string } = {},
): InvoicePdfData {
  const issuedOn = quote.createdAt.slice(0, 10);
  const taxYear =
    quote.jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${issuedOn}T00:00:00Z`));

  const gst = calculateGst(
    { net: quote.subtotal, treatment: quote.gstTreatment },
    quote.jurisdiction,
    taxYear,
  );

  const taxNumber =
    quote.jurisdiction === 'NZ' ? settings.nzGstNumber || settings.nzIrdNumber : settings.auAbn;
  const taxNumberLabel =
    quote.jurisdiction === 'NZ' ? (settings.nzGstNumber ? 'GST No.' : 'IRD No.') : 'ABN';

  return {
    kind: 'quote',
    number: quote.number,
    issuedOn,
    dueOn: quote.expiresOn ?? issuedOn,
    currency: quote.currency,
    jurisdiction: quote.jurisdiction,
    gstTreatment: quote.gstTreatment,
    gstLabel: gst.label,
    reference: quote.reference,
    notes: [quote.body, quote.notes].filter(Boolean).join('\n\n'),
    terms: quote.terms,

    from: {
      businessName: settings.businessName || 'Your business',
      legalName: settings.legalName,
      addressLines: [
        settings.addressLine1,
        settings.addressLine2,
        [settings.city, settings.postcode].filter(Boolean).join(' '),
      ].filter(Boolean),
      email: settings.email,
      phone: settings.phone,
      website: settings.website,
      taxNumber,
      taxNumberLabel,
    },

    to: {
      name: quote.client?.name ?? 'Client',
      addressLines: [
        quote.client?.addressLine1 ?? '',
        quote.client?.addressLine2 ?? '',
        [quote.client?.city ?? '', quote.client?.postcode ?? ''].filter(Boolean).join(' '),
      ].filter(Boolean),
      email: quote.client?.email ?? '',
      taxNumber: quote.client?.taxNumber ?? '',
    },

    lines: quote.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),

    subtotal: quote.subtotal,
    gstAmount: quote.gstAmount,
    total: quote.total,
    amountPaid: 0,

    /**
     * No bank details on a quote. Nothing is payable yet, and printing an
     * account number on a document that is not a demand for money invites
     * someone to pay against a job that has not been agreed.
     */
    bank: { accountName: '', accountNumber: '', bankName: '', bsb: '', swift: '' },

    payUrl: options.viewUrl,
    footer: settings.invoiceFooter,
  };
}
