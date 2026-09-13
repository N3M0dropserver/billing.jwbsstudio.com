/**
 * Renders an invoice to a PDF.
 *
 * Layout notes: an invoice has to survive being printed, forwarded to an
 * accounts department, and read on a phone. So: one page where possible,
 * generous leading, the amount due unmissable, and the payment details in a
 * block someone can copy without squinting.
 *
 * Both IRD and the ATO require specific wording on a tax invoice. The
 * function emits the right heading and identifiers for the jurisdiction.
 */

import { PdfDocument, wrapText, measureText, type FontName } from './writer';
import { formatMoneyWithCode, type Cents, type Currency } from '~/lib/tax/money';

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

const MARGIN = 48;
const INK: [number, number, number] = [0.09, 0.09, 0.09];
const MUTED: [number, number, number] = [0.45, 0.45, 0.45];
const RULE: [number, number, number] = [0.85, 0.85, 0.85];
const BRAND: [number, number, number] = [0.13, 0.36, 0.3];

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * NZ calls it a "Tax invoice" only when GST is charged; Australia requires
 * the words "Tax invoice" on any invoice over $82.50 from a GST-registered
 * supplier. When not registered, calling it a tax invoice is wrong.
 */
function documentTitle(data: InvoicePdfData): string {
  if (data.kind === 'quote') return 'QUOTE';
  // A business that is not GST registered must not issue a "tax invoice" —
  // the term means a document that supports a GST input claim.
  if (data.gstTreatment === 'not-registered') return 'INVOICE';
  return 'TAX INVOICE';
}

export function renderInvoicePdf(data: InvoicePdfData): Uint8Array {
  const doc = new PdfDocument();
  const page = doc.addPage();
  const contentWidth = page.width - MARGIN * 2;
  const right = page.width - MARGIN;

  let y = MARGIN + 10;

  // ---- Header -----------------------------------------------------------
  page.text(data.from.businessName || 'Invoice', MARGIN, y, {
    font: 'Helvetica-Bold',
    size: 17,
    color: BRAND,
  });

  page.text(documentTitle(data), MARGIN, y, {
    font: 'Helvetica-Bold',
    size: 17,
    color: INK,
    align: 'right',
    width: contentWidth,
  });

  y += 18;
  page.text(data.number, MARGIN, y, {
    size: 10,
    color: MUTED,
    align: 'right',
    width: contentWidth,
  });

  // Supplier block
  let fromY = y;
  const fromLines = [
    data.from.legalName && data.from.legalName !== data.from.businessName
      ? data.from.legalName
      : '',
    ...data.from.addressLines,
    data.from.email,
    data.from.phone,
    data.from.website,
    data.from.taxNumber ? `${data.from.taxNumberLabel} ${data.from.taxNumber}` : '',
  ].filter(Boolean);

  for (const line of fromLines) {
    page.text(line, MARGIN, fromY, { size: 9, color: MUTED });
    fromY += 12;
  }

  y = Math.max(fromY, y + 16) + 18;
  page.line(MARGIN, y, right, y, { color: RULE });
  y += 22;

  // ---- Bill to / dates --------------------------------------------------
  const columnWidth = contentWidth / 2 - 12;

  page.text('BILL TO', MARGIN, y, { font: 'Helvetica-Bold', size: 8, color: MUTED });
  page.text('DETAILS', MARGIN + columnWidth + 24, y, {
    font: 'Helvetica-Bold',
    size: 8,
    color: MUTED,
  });
  y += 15;

  const toLines = [
    data.to.name,
    ...data.to.addressLines,
    data.to.email,
    data.to.taxNumber,
  ].filter(Boolean);

  const detailRows: Array<[string, string]> = [
    ['Issued', formatDate(data.issuedOn)],
    [data.kind === 'quote' ? 'Valid until' : 'Due', formatDate(data.dueOn)],
  ];
  if (data.reference) detailRows.push(['Reference', data.reference]);

  const blockTop = y;
  let toY = y;
  toLines.forEach((line, i) => {
    page.text(line, MARGIN, toY, {
      font: i === 0 ? 'Helvetica-Bold' : 'Helvetica',
      size: i === 0 ? 10 : 9,
      color: i === 0 ? INK : MUTED,
    });
    toY += i === 0 ? 15 : 12;
  });

  let detailY = blockTop;
  const detailX = MARGIN + columnWidth + 24;
  for (const [label, value] of detailRows) {
    page.text(label, detailX, detailY, { size: 9, color: MUTED });
    page.text(value, detailX + 70, detailY, { size: 9, color: INK });
    detailY += 13;
  }

  y = Math.max(toY, detailY) + 20;

  // ---- Line items -------------------------------------------------------
  const columns = {
    description: MARGIN,
    quantity: MARGIN + contentWidth * 0.52,
    unitPrice: MARGIN + contentWidth * 0.66,
    amount: MARGIN + contentWidth * 0.82,
  };
  const numberColumnWidth = contentWidth * 0.18;

  page.rect(MARGIN, y - 4, contentWidth, 20, [0.97, 0.97, 0.96]);
  page.text('DESCRIPTION', columns.description + 6, y + 9, {
    font: 'Helvetica-Bold', size: 8, color: MUTED,
  });
  page.text('QTY', columns.quantity, y + 9, {
    font: 'Helvetica-Bold', size: 8, color: MUTED, align: 'right', width: contentWidth * 0.12,
  });
  page.text('RATE', columns.unitPrice, y + 9, {
    font: 'Helvetica-Bold', size: 8, color: MUTED, align: 'right', width: contentWidth * 0.14,
  });
  page.text('AMOUNT', columns.amount, y + 9, {
    font: 'Helvetica-Bold', size: 8, color: MUTED, align: 'right', width: numberColumnWidth - 6,
  });

  y += 26;

  for (const line of data.lines) {
    const descriptionWidth = contentWidth * 0.50;
    const wrapped = wrapText(line.description, descriptionWidth, 9.5);

    wrapped.forEach((text, i) => {
      page.text(text, columns.description + 6, y + i * 12, { size: 9.5, color: INK });
    });

    const quantity = (line.quantity / 1000).toFixed(2).replace(/\.00$/, '');
    page.text(`${quantity} ${line.unit}`, columns.quantity, y, {
      size: 9.5, color: MUTED, align: 'right', width: contentWidth * 0.12,
    });
    page.text(formatMoneyWithCode(line.unitPrice, data.currency), columns.unitPrice, y, {
      size: 9.5, color: MUTED, align: 'right', width: contentWidth * 0.14,
    });
    page.text(formatMoneyWithCode(line.lineTotal, data.currency), columns.amount, y, {
      size: 9.5, color: INK, align: 'right', width: numberColumnWidth - 6,
    });

    y += Math.max(wrapped.length, 1) * 12 + 8;
    page.line(MARGIN, y - 4, right, y - 4, { color: [0.93, 0.93, 0.93] });
  }

  // ---- Totals -----------------------------------------------------------
  y += 12;
  const totalsX = MARGIN + contentWidth * 0.55;
  const totalsWidth = contentWidth * 0.45;

  const totalRow = (label: string, value: string, options: { bold?: boolean; size?: number } = {}) => {
    const font: FontName = options.bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = options.size ?? 9.5;
    page.text(label, totalsX, y, { size, color: options.bold ? INK : MUTED, font });
    page.text(value, totalsX, y, {
      size, color: INK, font, align: 'right', width: totalsWidth - 6,
    });
    y += size + 8;
  };

  totalRow('Subtotal', formatMoneyWithCode(data.subtotal, data.currency));
  totalRow(data.gstLabel, formatMoneyWithCode(data.gstAmount, data.currency));

  page.line(totalsX, y - 4, right, y - 4, { color: RULE });
  y += 6;
  totalRow('Total', formatMoneyWithCode(data.total, data.currency), { bold: true, size: 11 });

  if (data.amountPaid > 0) {
    totalRow('Paid', `-${formatMoneyWithCode(data.amountPaid, data.currency)}`);
    page.line(totalsX, y - 4, right, y - 4, { color: RULE });
    y += 6;
    totalRow(
      'Amount due',
      formatMoneyWithCode(data.total - data.amountPaid, data.currency),
      { bold: true, size: 13 },
    );
  } else {
    y += 2;
    page.text('Amount due', totalsX, y, { font: 'Helvetica-Bold', size: 13, color: INK });
    page.text(formatMoneyWithCode(data.total, data.currency), totalsX, y, {
      font: 'Helvetica-Bold', size: 13, color: BRAND, align: 'right', width: totalsWidth - 6,
    });
    y += 24;
  }

  // Export invoices must say why no GST was charged.
  if (data.gstTreatment === 'zero-rated-export') {
    page.text(
      data.jurisdiction === 'NZ'
        ? 'Zero-rated supply of services to a non-resident outside New Zealand.'
        : 'GST-free export of services to a non-resident outside Australia.',
      MARGIN,
      y,
      { size: 8.5, color: MUTED },
    );
    y += 16;
  }

  // ---- Payment details --------------------------------------------------
  y = Math.max(y + 12, page.height - 200);
  page.line(MARGIN, y, right, y, { color: RULE });
  y += 18;

  page.text('HOW TO PAY', MARGIN, y, { font: 'Helvetica-Bold', size: 8, color: MUTED });
  y += 15;

  const bankRows: Array<[string, string]> = [];
  if (data.bank.accountName) bankRows.push(['Account name', data.bank.accountName]);
  if (data.bank.accountNumber) bankRows.push(['Account number', data.bank.accountNumber]);
  if (data.bank.bsb) bankRows.push(['BSB', data.bank.bsb]);
  if (data.bank.bankName) bankRows.push(['Bank', data.bank.bankName]);
  if (data.bank.swift) bankRows.push(['SWIFT', data.bank.swift]);
  bankRows.push(['Reference', data.number]);

  for (const [label, value] of bankRows) {
    page.text(label, MARGIN, y, { size: 9, color: MUTED });
    page.text(value, MARGIN + 90, y, { size: 9, color: INK });
    y += 12;
  }

  if (data.payUrl) {
    y += 4;
    page.text('Or pay by card:', MARGIN, y, { size: 9, color: MUTED });
    page.text(data.payUrl, MARGIN + 90, y, { size: 8.5, color: BRAND });
    y += 14;
  }

  // ---- Footer -----------------------------------------------------------
  const footerText = [data.terms, data.notes, data.footer].filter(Boolean).join('  ·  ');
  if (footerText) {
    const footerLines = wrapText(footerText, contentWidth, 8);
    let footerY = page.height - MARGIN - footerLines.length * 10;
    for (const line of footerLines) {
      page.text(line, MARGIN, footerY, { size: 8, color: MUTED });
      footerY += 10;
    }
  }

  return doc.build({
    title: `${data.kind === 'quote' ? 'Quote' : 'Invoice'} ${data.number}`,
    author: data.from.businessName,
  });
}

export { measureText };
