/**
 * A stand-in invoice, for previewing a template against.
 *
 * Built from the account's own settings rather than invented wholesale: the
 * point of a preview is to show what YOUR invoices will look like, and a
 * preview carrying someone else's business name tells you nothing about
 * whether your logo sits well next to it.
 *
 * Only the client and the work are fictional. The amounts are chosen to
 * exercise the parts of the layout that break — a description long enough to
 * wrap, a part payment so the "amount due" row appears, and figures wide
 * enough to test the money columns.
 */

import type { Settings } from '~/lib/db/schema';
import type { InvoicePdfData } from '~/lib/pdf/invoice';
import { calculateGst } from '~/lib/tax/gst';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';

export function sampleInvoice(settings: Settings, appUrl: string): InvoicePdfData {
  const jurisdiction = settings.taxResidence;
  const issued = new Date();
  const due = new Date(issued.getTime() + settings.defaultPaymentTermsDays * 86_400_000);
  const issuedOn = issued.toISOString().slice(0, 10);

  const registered = jurisdiction === 'NZ' ? settings.nzGstRegistered : settings.auGstRegistered;
  const treatment = registered ? 'standard' : 'not-registered';

  const subtotal = 534_000;
  const taxYear =
    jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${issuedOn}T00:00:00Z`));
  const gst = calculateGst({ net: subtotal, treatment }, jurisdiction, taxYear);

  const taxNumber =
    jurisdiction === 'NZ' ? settings.nzGstNumber || settings.nzIrdNumber : settings.auAbn;
  const taxNumberLabel =
    jurisdiction === 'NZ' ? (settings.nzGstNumber ? 'GST No.' : 'IRD No.') : 'ABN';

  return {
    number: `${settings.invoiceNumberPrefix}${String(settings.invoiceNextNumber).padStart(4, '0')}`,
    issuedOn,
    dueOn: due.toISOString().slice(0, 10),
    currency: settings.defaultCurrency,
    jurisdiction,
    gstTreatment: treatment,
    gstLabel: gst.label,
    reference: 'Website refresh',
    notes: 'Thanks — it was a pleasure working on this.',
    terms: `Payment due within ${settings.defaultPaymentTermsDays} days.`,

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
      name: 'Sample Client Limited',
      addressLines: ['128 Example Street', 'Newtown, Wellington 6021'],
      email: 'accounts@example.com',
      taxNumber: '',
    },

    lines: [
      {
        description:
          'Brand identity — logo system, wordmark and supporting marks, including three rounds of revision',
        quantity: 24_000,
        unit: 'hours',
        unitPrice: 12_000,
        lineTotal: 288_000,
      },
      { description: 'Brand guidelines document', quantity: 8_000, unit: 'hours', unitPrice: 12_000, lineTotal: 96_000 },
      { description: 'Packaging artwork', quantity: 1_000, unit: 'fixed', unitPrice: 150_000, lineTotal: 150_000 },
    ],

    subtotal,
    gstAmount: gst.gst,
    total: subtotal + gst.gst,
    // A part payment, so the preview shows the "Paid" and "Amount due" rows
    // that a template has to look right with.
    amountPaid: 100_000,

    bank: {
      accountName: settings.bankAccountName,
      accountNumber: settings.bankAccountNumber,
      bankName: settings.bankName,
      bsb: settings.bankBsb,
      swift: settings.bankSwift,
    },

    payUrl: `${appUrl}/pay/preview`,
    footer: settings.invoiceFooter,
  };
}
