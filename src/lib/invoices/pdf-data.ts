import type { InvoiceWithLines } from './service';
import type { Settings } from '~/lib/db/schema';
import type { InvoicePdfData } from '~/lib/pdf/invoice';
import { calculateGst } from '~/lib/tax/gst';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';

/** Map a stored invoice onto the shape the PDF renderer wants. */
export function toPdfData(
  invoice: InvoiceWithLines,
  settings: Settings,
  options: { payUrl?: string } = {},
): InvoicePdfData {
  const taxYear =
    invoice.jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${invoice.issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${invoice.issuedOn}T00:00:00Z`));

  const gst = calculateGst(
    { net: invoice.subtotal, treatment: invoice.gstTreatment },
    invoice.jurisdiction,
    taxYear,
  );

  const taxNumber =
    invoice.jurisdiction === 'NZ' ? settings.nzGstNumber || settings.nzIrdNumber : settings.auAbn;
  const taxNumberLabel =
    invoice.jurisdiction === 'NZ' ? (settings.nzGstNumber ? 'GST No.' : 'IRD No.') : 'ABN';

  return {
    number: invoice.number,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    currency: invoice.currency,
    jurisdiction: invoice.jurisdiction,
    gstTreatment: invoice.gstTreatment,
    gstLabel: gst.label,
    reference: invoice.reference,
    notes: invoice.notes,
    terms: invoice.terms,

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
      name: invoice.client?.name ?? 'Client',
      addressLines: [
        invoice.client?.addressLine1 ?? '',
        invoice.client?.addressLine2 ?? '',
        [invoice.client?.city, invoice.client?.postcode].filter(Boolean).join(' '),
      ].filter(Boolean),
      email: invoice.client?.email ?? '',
      taxNumber: invoice.client?.taxNumber ?? '',
    },

    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),

    subtotal: invoice.subtotal,
    gstAmount: invoice.gstAmount,
    total: invoice.total,
    amountPaid: invoice.amountPaid,

    bank: {
      accountName: settings.bankAccountName,
      accountNumber: settings.bankAccountNumber,
      bankName: settings.bankName,
      bsb: settings.bankBsb,
      swift: settings.bankSwift,
    },

    payUrl: options.payUrl,
    footer: settings.invoiceFooter,
  };
}
