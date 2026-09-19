/**
 * The four invoice layouts.
 *
 * Each one is a different arrangement of the same fixed set of blocks — who
 * it is from, who it is to, the dates, the lines, the totals, how to pay. A
 * layout chooses where those go and what is filled with colour; it does not
 * get to choose whether the tax wording appears, because that is not a design
 * decision. `documentTitle` and the export note are shared for exactly that
 * reason.
 *
 * The line-item table paginates. That matters more than it sounds: before
 * this, an invoice with thirty lines drew them straight off the bottom of the
 * page and the totals with them, and nothing said so.
 */

import { PdfDocument, PdfPage, wrapText, measureText, fitWithin, type FontName, type ImageHandle } from './writer';
import { formatMoneyWithCode, type Cents, type Currency } from '~/lib/tax/money';
import { palette, type InvoiceTemplateDesign, type Palette, type Rgb } from './template';
import type { InvoicePdfData } from './invoice';

const MARGIN = 48;
/** How close to the bottom edge content may come before a page break. */
const BOTTOM_GUTTER = 64;
/** Width of the coloured column in the sidebar layout. */
const SIDEBAR_WIDTH = 176;

/**
 * A usable region of a page.
 *
 * Layouts hand these to the shared blocks so the same table code works
 * whether it is running full width or beside a sidebar.
 */
export interface Frame {
  page: PdfPage;
  x: number;
  width: number;
  top: number;
  bottom: number;
}

export interface LayoutContext {
  doc: PdfDocument;
  data: InvoicePdfData;
  design: InvoiceTemplateDesign;
  pal: Palette;
  logo: ImageHandle | null;
  /** Scale a type size by the template's setting. */
  s: (size: number) => number;
}

// ---------------------------------------------------------------------------
// Shared wording — not a layout's business
// ---------------------------------------------------------------------------

export function formatDate(iso: string): string {
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
export function documentTitle(data: InvoicePdfData): string {
  if (data.kind === 'quote') return 'QUOTE';
  // A business that is not GST registered must not issue a "tax invoice" —
  // the term means a document that supports a GST input claim.
  if (data.gstTreatment === 'not-registered') return 'INVOICE';
  return 'TAX INVOICE';
}

export function supplierLines(data: InvoicePdfData): string[] {
  return [
    data.from.legalName && data.from.legalName !== data.from.businessName ? data.from.legalName : '',
    ...data.from.addressLines,
    data.from.email,
    data.from.phone,
    data.from.website,
    data.from.taxNumber ? `${data.from.taxNumberLabel} ${data.from.taxNumber}` : '',
  ].filter(Boolean);
}

export function clientLines(data: InvoicePdfData): string[] {
  return [data.to.name, ...data.to.addressLines, data.to.email, data.to.taxNumber].filter(Boolean);
}

export function detailRows(data: InvoicePdfData): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Issued', formatDate(data.issuedOn)],
    [data.kind === 'quote' ? 'Valid until' : 'Due', formatDate(data.dueOn)],
  ];
  if (data.reference) rows.push(['Reference', data.reference]);
  return rows;
}

export function bankRows(data: InvoicePdfData): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (data.bank.accountName) rows.push(['Account name', data.bank.accountName]);
  if (data.bank.accountNumber) rows.push(['Account number', data.bank.accountNumber]);
  if (data.bank.bsb) rows.push(['BSB', data.bank.bsb]);
  if (data.bank.bankName) rows.push(['Bank', data.bank.bankName]);
  if (data.bank.swift) rows.push(['SWIFT', data.bank.swift]);
  rows.push(['Reference', data.number]);
  return rows;
}

/** The sentence an export invoice has to carry, or empty when it is not one. */
export function exportNote(data: InvoicePdfData): string {
  if (data.gstTreatment !== 'zero-rated-export') return '';
  return data.jurisdiction === 'NZ'
    ? 'Zero-rated supply of services to a non-resident outside New Zealand.'
    : 'GST-free export of services to a non-resident outside Australia.';
}

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

/** A small uppercase label — "BILL TO", "HOW TO PAY". */
function label(page: PdfPage, text: string, x: number, y: number, ctx: LayoutContext, colour?: Rgb): void {
  page.text(text, x, y, {
    font: 'Helvetica-Bold',
    size: ctx.s(8),
    color: colour ?? ctx.pal.muted,
  });
}

/**
 * Draw the logo, returning the space it actually took.
 *
 * `within` is the column it is being placed in; the template's `logo.position`
 * decides where in that column it lands. A logo is scaled to fit rather than
 * stretched — it arrives at whatever size the person had to hand, and a
 * squashed wordmark is worse than a small one.
 */
function drawLogo(
  page: PdfPage,
  ctx: LayoutContext,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  within = maxWidth,
): { width: number; height: number } {
  if (!ctx.logo) return { width: 0, height: 0 };

  const box = fitWithin(ctx.logo.width, ctx.logo.height, maxWidth, maxHeight);
  const slack = Math.max(0, within - box.width);
  const offset =
    ctx.design.logo.position === 'right'
      ? slack
      : ctx.design.logo.position === 'centre'
        ? slack / 2
        : 0;

  page.image(ctx.logo, x + offset, y, box.width, box.height);
  return box;
}

/**
 * Key/value rows, as used by the details, bank and any other paired block.
 * Returns the y below the last row.
 */
function rows(
  page: PdfPage,
  ctx: LayoutContext,
  entries: Array<[string, string]>,
  x: number,
  y: number,
  labelWidth: number,
  colours: { label: Rgb; value: Rgb },
  size = 9,
): number {
  let at = y;
  for (const [name, value] of entries) {
    page.text(name, x, at, { size: ctx.s(size), color: colours.label });
    page.text(value, x + labelWidth, at, { size: ctx.s(size), color: colours.value });
    at += ctx.s(size) + ctx.s(3.5);
  }
  return at;
}

/** A stacked block of plain lines, the first optionally emphasised. */
function stack(
  page: PdfPage,
  ctx: LayoutContext,
  lines: string[],
  x: number,
  y: number,
  colours: { first: Rgb; rest: Rgb },
  options: { firstSize?: number; size?: number; boldFirst?: boolean; width?: number } = {},
): number {
  const size = options.size ?? 9;
  const firstSize = options.firstSize ?? size;
  let at = y;

  lines.forEach((line, i) => {
    const isFirst = i === 0;
    const lineSize = isFirst ? firstSize : size;
    // Wrap rather than run off the edge — a long legal name or a sidebar
    // column makes this a real case, not a defensive one.
    const parts = options.width
      ? wrapText(line, options.width, ctx.s(lineSize), isFirst && options.boldFirst ? 'Helvetica-Bold' : 'Helvetica')
      : [line];

    for (const part of parts) {
      page.text(part, x, at, {
        font: isFirst && options.boldFirst ? 'Helvetica-Bold' : 'Helvetica',
        size: ctx.s(lineSize),
        color: isFirst ? colours.first : colours.rest,
      });
      at += ctx.s(lineSize) + ctx.s(3.5);
    }
  });

  return at;
}

/**
 * The line-item table, across as many pages as it needs.
 *
 * `nextFrame` is how the layout keeps its chrome consistent: the table asks
 * for another page and gets back a region with the sidebar or band already
 * drawn on it.
 */
function lineItems(
  ctx: LayoutContext,
  frame: Frame,
  y: number,
  nextFrame: () => Frame,
): { frame: Frame; y: number } {
  const { data, pal, design } = ctx;

  let current = frame;
  let at = y;

  /**
   * Column widths are measured, not apportioned.
   *
   * Fixed percentages looked fine at full width and collided the moment a
   * layout got narrower — "1 fixed" ran into "NZ$1,500.00" in the sidebar,
   * because a percentage of a smaller frame is smaller than the text it has
   * to hold. Measuring the widest value each column will actually carry costs
   * one pass over the lines and cannot collide.
   */
  const columns = (f: Frame) => {
    const money = (cents: Cents) => formatMoneyWithCode(cents, data.currency);
    const body = ctx.s(9.5);
    const head = ctx.s(8);

    const widest = (values: string[], size: number, font?: FontName) =>
      values.reduce((max, value) => Math.max(max, measureText(value, size, font)), 0);

    const quantityWidth = Math.max(
      widest(data.lines.map((l) => `${(l.quantity / 1000).toFixed(2).replace(/\.00$/, '')} ${l.unit}`), body),
      measureText('QTY', head, 'Helvetica-Bold'),
    );
    const unitPriceWidth = Math.max(
      widest(data.lines.map((l) => money(l.unitPrice)), body),
      measureText('RATE', head, 'Helvetica-Bold'),
    );
    const amountWidth = Math.max(
      widest(data.lines.map((l) => money(l.lineTotal)), body),
      measureText('AMOUNT', head, 'Helvetica-Bold'),
    );

    const gap = ctx.s(14);
    const amount = f.x + f.width - amountWidth - 6;
    const unitPrice = amount - gap - unitPriceWidth;
    const quantity = unitPrice - gap - quantityWidth;

    return {
      description: f.x,
      // The description gets whatever the numbers do not need. A floor keeps
      // it usable if someone invoices in a currency with very long figures.
      descriptionWidth: Math.max(quantity - f.x - ctx.s(12), ctx.s(90)),
      quantity,
      quantityWidth,
      unitPrice,
      unitPriceWidth,
      amount,
      amountWidth,
    };
  };

  const header = (f: Frame, top: number): number => {
    const c = columns(f);
    f.page.rect(f.x, top - 4, f.width, ctx.s(20), pal.tableHeader);
    const textY = top + ctx.s(9);
    label(f.page, 'DESCRIPTION', c.description + 6, textY, ctx);
    f.page.text('QTY', c.quantity, textY, {
      font: 'Helvetica-Bold', size: ctx.s(8), color: pal.muted, align: 'right', width: c.quantityWidth,
    });
    f.page.text('RATE', c.unitPrice, textY, {
      font: 'Helvetica-Bold', size: ctx.s(8), color: pal.muted, align: 'right', width: c.unitPriceWidth,
    });
    f.page.text('AMOUNT', c.amount, textY, {
      font: 'Helvetica-Bold', size: ctx.s(8), color: pal.muted, align: 'right', width: c.amountWidth,
    });
    return top + ctx.s(26);
  };

  at = header(current, at);

  let striped = false;
  for (const line of data.lines) {
    const c = columns(current);
    const wrapped = wrapText(line.description, c.descriptionWidth, ctx.s(9.5));
    const rowHeight = Math.max(wrapped.length, 1) * ctx.s(12) + ctx.s(8);

    // Break before drawing, so a wrapped description is never split in half.
    if (at + rowHeight > current.bottom) {
      current = nextFrame();
      at = header(current, current.top);
      striped = false;
    }

    if (design.options.stripeRows && striped) {
      current.page.rect(current.x, at - ctx.s(5), current.width, rowHeight, pal.stripe);
    }
    striped = !striped;

    wrapped.forEach((text, i) => {
      current.page.text(text, c.description + 6, at + i * ctx.s(12), {
        size: ctx.s(9.5),
        color: pal.text,
      });
    });

    const quantity = (line.quantity / 1000).toFixed(2).replace(/\.00$/, '');
    current.page.text(`${quantity} ${line.unit}`, c.quantity, at, {
      size: ctx.s(9.5), color: pal.muted, align: 'right', width: c.quantityWidth,
    });
    current.page.text(formatMoneyWithCode(line.unitPrice, data.currency), c.unitPrice, at, {
      size: ctx.s(9.5), color: pal.muted, align: 'right', width: c.unitPriceWidth,
    });
    current.page.text(formatMoneyWithCode(line.lineTotal, data.currency), c.amount, at, {
      size: ctx.s(9.5), color: pal.text, align: 'right', width: c.amountWidth,
    });

    at += rowHeight;
    current.page.line(current.x, at - 4, current.x + current.width, at - 4, {
      color: pal.rule,
      width: 0.4,
    });
  }

  return { frame: current, y: at };
}

/**
 * Subtotal, tax, total and the amount due.
 *
 * The amount due is the one number on the page that has to survive being
 * skim-read, so it is the largest thing on it and — unless the template says
 * otherwise — sits in a filled panel.
 */
function totals(
  ctx: LayoutContext,
  frame: Frame,
  y: number,
  nextFrame: () => Frame,
): { frame: Frame; y: number } {
  const { data, pal, design } = ctx;

  const needed = ctx.s(design.options.highlightTotal ? 130 : 110);
  let current = frame;
  let at = y + ctx.s(12);

  if (at + needed > current.bottom) {
    current = nextFrame();
    at = current.top;
  }

  const due = formatMoneyWithCode(data.total - data.amountPaid, data.currency);
  const dueLabel = data.kind === 'quote' ? 'Total' : 'Amount due';

  /**
   * Wide enough for the widest row it has to hold, and never less than the
   * proportion the layouts were designed around. Same lesson as the table:
   * a percentage of a narrow frame is not a width.
   */
  const rowWidths = [
    measureText('Subtotal', ctx.s(9.5)) + measureText(formatMoneyWithCode(data.subtotal, data.currency), ctx.s(9.5)),
    measureText(data.gstLabel, ctx.s(9.5)) + measureText(formatMoneyWithCode(data.gstAmount, data.currency), ctx.s(9.5)),
    measureText('Total', ctx.s(11), 'Helvetica-Bold') + measureText(formatMoneyWithCode(data.total, data.currency), ctx.s(11), 'Helvetica-Bold'),
    measureText(dueLabel, ctx.s(10), 'Helvetica-Bold') + measureText(due, ctx.s(13), 'Helvetica-Bold') + ctx.s(20),
  ];

  const width = Math.min(
    current.width,
    Math.max(current.width * 0.45, ...rowWidths.map((w) => w + ctx.s(24))),
  );
  const x = current.x + current.width - width;
  const right = current.x + current.width;

  const row = (name: string, value: string, options: { bold?: boolean; size?: number } = {}) => {
    const font: FontName = options.bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = ctx.s(options.size ?? 9.5);
    current.page.text(name, x, at, { size, color: options.bold ? pal.text : pal.muted, font });
    current.page.text(value, x, at, { size, color: pal.text, font, align: 'right', width: width - 6 });
    at += size + ctx.s(8);
  };

  row('Subtotal', formatMoneyWithCode(data.subtotal, data.currency));
  row(data.gstLabel, formatMoneyWithCode(data.gstAmount, data.currency));

  if (data.amountPaid > 0) {
    current.page.line(x, at - 4, right, at - 4, { color: pal.rule });
    at += ctx.s(6);
    row('Total', formatMoneyWithCode(data.total, data.currency), { bold: true, size: 11 });
    row('Paid', `-${formatMoneyWithCode(data.amountPaid, data.currency)}`);
  } else {
    current.page.line(x, at - 4, right, at - 4, { color: pal.rule });
    at += ctx.s(6);
    row('Total', formatMoneyWithCode(data.total, data.currency), { bold: true, size: 11 });
  }

  if (design.options.highlightTotal) {
    // If the label and the figure cannot sit side by side, stack them rather
    // than let them overlap — a smudged total is worse than a taller panel.
    const inline =
      measureText(dueLabel, ctx.s(10), 'Helvetica-Bold') +
        measureText(due, ctx.s(13), 'Helvetica-Bold') +
        ctx.s(30) <=
      width;

    const height = inline ? ctx.s(34) : ctx.s(48);
    current.page.rect(x, at, width, height, pal.accent);

    if (inline) {
      const textY = at + height / 2 + ctx.s(4);
      current.page.text(dueLabel, x + ctx.s(10), textY, {
        font: 'Helvetica-Bold', size: ctx.s(10), color: pal.accentText,
      });
      current.page.text(due, x, textY, {
        font: 'Helvetica-Bold', size: ctx.s(13), color: pal.accentText,
        align: 'right', width: width - ctx.s(10),
      });
    } else {
      current.page.text(dueLabel, x + ctx.s(10), at + ctx.s(16), {
        font: 'Helvetica-Bold', size: ctx.s(9), color: pal.accentText,
      });
      current.page.text(due, x, at + ctx.s(34), {
        font: 'Helvetica-Bold', size: ctx.s(13), color: pal.accentText,
        align: 'right', width: width - ctx.s(10),
      });
    }
    at += height + ctx.s(12);
  } else {
    current.page.line(x, at - 4, right, at - 4, { color: pal.rule, width: 1 });
    at += ctx.s(10);
    current.page.text(dueLabel, x, at, { font: 'Helvetica-Bold', size: ctx.s(13), color: pal.text });
    current.page.text(due, x, at, {
      font: 'Helvetica-Bold', size: ctx.s(13), color: pal.accent, align: 'right', width: width - 6,
    });
    at += ctx.s(26);
  }

  const note = exportNote(data);
  if (note) {
    const lines = wrapText(note, current.width, ctx.s(8.5));
    for (const line of lines) {
      current.page.text(line, current.x, at, { size: ctx.s(8.5), color: pal.muted });
      at += ctx.s(11);
    }
    at += ctx.s(6);
  }

  return { frame: current, y: at };
}

/** "How to pay", for the layouts that carry it in the body. */
function payment(ctx: LayoutContext, frame: Frame, y: number, nextFrame: () => Frame): number {
  const { data, pal, design } = ctx;
  if (!design.options.showBankDetails && !(design.options.showPayLink && data.payUrl)) return y;

  const entries = design.options.showBankDetails ? bankRows(data) : [];
  const needed = ctx.s(40 + entries.length * 13);

  let current = frame;
  let at = y;
  if (at + needed > current.bottom) {
    current = nextFrame();
    at = current.top;
  }

  current.page.line(current.x, at, current.x + current.width, at, { color: pal.rule });
  at += ctx.s(18);

  label(current.page, 'HOW TO PAY', current.x, at, ctx);
  at += ctx.s(15);

  if (entries.length) {
    at = rows(current.page, ctx, entries, current.x, at, ctx.s(90), { label: pal.muted, value: pal.text });
  }

  if (design.options.showPayLink && data.payUrl) {
    at += ctx.s(4);
    current.page.text('Or pay by card:', current.x, at, { size: ctx.s(9), color: pal.muted });
    current.page.text(data.payUrl, current.x + ctx.s(90), at, { size: ctx.s(8.5), color: pal.accent });
    at += ctx.s(14);
  }

  return at;
}

/** Terms, notes and the footer line, pinned to the bottom of the last page. */
function footer(ctx: LayoutContext, frame: Frame): void {
  const { data, pal } = ctx;
  const text = [data.terms, data.notes, data.footer].filter(Boolean).join('  ·  ');
  if (!text) return;

  const lines = wrapText(text, frame.width, ctx.s(8));
  let at = frame.page.height - MARGIN - lines.length * ctx.s(10);
  for (const line of lines) {
    frame.page.text(line, frame.x, at, { size: ctx.s(8), color: pal.muted });
    at += ctx.s(10);
  }
}

/** Paint the page background, when the template asks for one. */
function background(page: PdfPage, pal: Palette): void {
  const [r, g, b] = pal.background;
  if (r > 0.995 && g > 0.995 && b > 0.995) return;
  page.rect(0, 0, page.width, page.height, pal.background);
}

// ---------------------------------------------------------------------------
// The layouts
// ---------------------------------------------------------------------------

export type LayoutRenderer = (ctx: LayoutContext) => void;

/**
 * Classic — the arrangement this system has always used.
 *
 * Business identity top-left, document title and number top-right, supplier
 * details beneath, then bill-to and dates side by side.
 */
const classic: LayoutRenderer = (ctx) => {
  const { doc, data, pal, design } = ctx;

  const makeFrame = (page: PdfPage, top: number): Frame => ({
    page,
    x: MARGIN,
    width: page.width - MARGIN * 2,
    top,
    bottom: page.height - BOTTOM_GUTTER,
  });

  const newPage = (): Frame => {
    const page = doc.addPage();
    background(page, pal);
    return makeFrame(page, MARGIN);
  };

  const page = doc.addPage();
  background(page, pal);
  const width = page.width - MARGIN * 2;
  let y = MARGIN + ctx.s(10);

  // Identity, left.
  let headerBottom = y;
  if (ctx.logo) {
    const box = drawLogo(page, ctx, MARGIN, y - ctx.s(6), design.logo.size, ctx.s(56), width * 0.5);
    headerBottom = y - ctx.s(6) + box.height + ctx.s(10);
    if (design.options.showBusinessName && data.from.businessName) {
      page.text(data.from.businessName, MARGIN, headerBottom + ctx.s(4), {
        font: 'Helvetica-Bold', size: ctx.s(13), color: pal.accent,
      });
      headerBottom += ctx.s(20);
    }
  } else {
    page.text(data.from.businessName || 'Invoice', MARGIN, y, {
      font: 'Helvetica-Bold', size: ctx.s(17), color: pal.accent,
    });
    headerBottom = y + ctx.s(22);
  }

  // Title, right.
  page.text(documentTitle(data), MARGIN, y, {
    font: 'Helvetica-Bold', size: ctx.s(17), color: pal.text, align: 'right', width,
  });
  page.text(data.number, MARGIN, y + ctx.s(18), {
    size: ctx.s(10), color: pal.muted, align: 'right', width,
  });

  const supplierBottom = stack(page, ctx, supplierLines(data), MARGIN, headerBottom, {
    first: pal.muted, rest: pal.muted,
  });

  y = Math.max(supplierBottom, y + ctx.s(52)) + ctx.s(14);
  page.line(MARGIN, y, page.width - MARGIN, y, { color: pal.rule });
  y += ctx.s(22);

  // Bill to / details.
  const columnWidth = width / 2 - 12;
  label(page, 'BILL TO', MARGIN, y, ctx);
  label(page, 'DETAILS', MARGIN + columnWidth + 24, y, ctx);
  y += ctx.s(15);

  const toBottom = stack(page, ctx, clientLines(data), MARGIN, y, { first: pal.text, rest: pal.muted }, {
    firstSize: 10, boldFirst: true, width: columnWidth,
  });
  const detailBottom = rows(page, ctx, detailRows(data), MARGIN + columnWidth + 24, y, ctx.s(70), {
    label: pal.muted, value: pal.text,
  });

  y = Math.max(toBottom, detailBottom) + ctx.s(20);

  const table = lineItems(ctx, makeFrame(page, y), y, newPage);
  const summed = totals(ctx, table.frame, table.y, newPage);
  const payY = payment(ctx, summed.frame, Math.max(summed.y + ctx.s(12), summed.frame.page.height - 200), newPage);
  footer(ctx, { ...summed.frame, top: payY });
};

/**
 * Banner — a filled band across the head of the page.
 *
 * The band is where the logo and the document title live, reversed out of the
 * accent colour. It is the layout that makes a brand colour actually felt,
 * which is the whole reason someone reaches for a template picker.
 */
const banner: LayoutRenderer = (ctx) => {
  const { doc, data, pal, design } = ctx;
  const bandHeight = ctx.s(128);

  const drawBand = (page: PdfPage, full: boolean) => {
    const height = full ? bandHeight : ctx.s(52);
    page.rect(0, 0, page.width, height, pal.accent);
    return height;
  };

  const makeFrame = (page: PdfPage, top: number): Frame => ({
    page,
    x: MARGIN,
    width: page.width - MARGIN * 2,
    top,
    bottom: page.height - BOTTOM_GUTTER,
  });

  const newPage = (): Frame => {
    const page = doc.addPage();
    background(page, pal);
    const height = drawBand(page, false);
    page.text(`${documentTitle(data)} ${data.number}`, MARGIN, height / 2 + ctx.s(4), {
      font: 'Helvetica-Bold', size: ctx.s(10), color: pal.accentText,
    });
    return makeFrame(page, height + ctx.s(28));
  };

  const page = doc.addPage();
  background(page, pal);
  drawBand(page, true);

  const width = page.width - MARGIN * 2;
  let bandY = MARGIN - ctx.s(6);

  if (ctx.logo) {
    const box = drawLogo(page, ctx, MARGIN, bandY, design.logo.size, ctx.s(46), width * 0.5);
    bandY += box.height + ctx.s(10);
  }
  if (design.options.showBusinessName && data.from.businessName) {
    page.text(data.from.businessName, MARGIN, bandY + ctx.s(10), {
      font: 'Helvetica-Bold', size: ctx.s(16), color: pal.accentText,
    });
  }

  // Title and number, reversed out on the right of the band.
  page.text(documentTitle(data), MARGIN, MARGIN - ctx.s(4), {
    font: 'Helvetica-Bold', size: ctx.s(17), color: pal.accentText, align: 'right', width,
  });
  page.text(data.number, MARGIN, MARGIN + ctx.s(16), {
    size: ctx.s(10), color: pal.accentText, align: 'right', width,
  });
  page.text(`${data.kind === 'quote' ? 'Valid until' : 'Due'} ${formatDate(data.dueOn)}`, MARGIN, MARGIN + ctx.s(32), {
    size: ctx.s(9), color: pal.accentText, align: 'right', width,
  });

  let y = bandHeight + ctx.s(30);

  const columnWidth = width / 3 - 8;
  label(page, 'FROM', MARGIN, y, ctx);
  label(page, 'BILL TO', MARGIN + columnWidth + 12, y, ctx);
  label(page, 'DETAILS', MARGIN + (columnWidth + 12) * 2, y, ctx);
  y += ctx.s(15);

  const fromBottom = stack(page, ctx, supplierLines(data), MARGIN, y, { first: pal.muted, rest: pal.muted }, {
    width: columnWidth,
  });
  const toBottom = stack(page, ctx, clientLines(data), MARGIN + columnWidth + 12, y, { first: pal.text, rest: pal.muted }, {
    firstSize: 10, boldFirst: true, width: columnWidth,
  });
  const detailBottom = rows(page, ctx, detailRows(data), MARGIN + (columnWidth + 12) * 2, y, ctx.s(62), {
    label: pal.muted, value: pal.text,
  });

  y = Math.max(fromBottom, toBottom, detailBottom) + ctx.s(22);

  const table = lineItems(ctx, makeFrame(page, y), y, newPage);
  const summed = totals(ctx, table.frame, table.y, newPage);
  const payY = payment(ctx, summed.frame, summed.y + ctx.s(16), newPage);
  footer(ctx, { ...summed.frame, top: payY });
};

/**
 * Sidebar — supplier identity and payment in a colour column on the left.
 *
 * Everything that is about the supplier rather than about this particular
 * invoice moves out of the flow, which leaves the right-hand column to be
 * only the lines and what is owed.
 */
const sidebar: LayoutRenderer = (ctx) => {
  const { doc, data, pal, design } = ctx;

  const contentX = SIDEBAR_WIDTH + ctx.s(32);

  const drawColumn = (page: PdfPage, full: boolean) => {
    page.rect(0, 0, SIDEBAR_WIDTH, page.height, pal.accent);
    if (!full) return;

    const inset = ctx.s(22);
    let at = MARGIN;

    if (ctx.logo) {
      const box = drawLogo(page, ctx, inset, at, SIDEBAR_WIDTH - inset * 2, ctx.s(64), SIDEBAR_WIDTH - inset * 2);
      at += box.height + ctx.s(16);
    }
    if (design.options.showBusinessName && data.from.businessName) {
      at = stack(page, ctx, [data.from.businessName], inset, at, { first: pal.accentText, rest: pal.accentText }, {
        firstSize: 13, boldFirst: true, width: SIDEBAR_WIDTH - inset * 2,
      }) + ctx.s(8);
    }

    at = stack(page, ctx, supplierLines(data), inset, at, { first: pal.accentText, rest: pal.accentText }, {
      size: 8.5, width: SIDEBAR_WIDTH - inset * 2,
    });

    if (design.options.showBankDetails) {
      at += ctx.s(18);
      label(page, 'HOW TO PAY', inset, at, ctx, pal.accentText);
      at += ctx.s(14);
      for (const [name, value] of bankRows(data)) {
        page.text(name, inset, at, { size: ctx.s(7.5), color: pal.accentText });
        at += ctx.s(10);
        for (const part of wrapText(value, SIDEBAR_WIDTH - inset * 2, ctx.s(9), 'Helvetica-Bold')) {
          page.text(part, inset, at, { font: 'Helvetica-Bold', size: ctx.s(9), color: pal.accentText });
          at += ctx.s(12);
        }
        at += ctx.s(3);
      }
    }

    if (design.options.showPayLink && data.payUrl) {
      at += ctx.s(10);
      label(page, 'PAY BY CARD', inset, at, ctx, pal.accentText);
      at += ctx.s(13);
      for (const part of wrapText(data.payUrl, SIDEBAR_WIDTH - inset * 2, ctx.s(7.5))) {
        page.text(part, inset, at, { size: ctx.s(7.5), color: pal.accentText });
        at += ctx.s(9.5);
      }
    }
  };

  const makeFrame = (page: PdfPage, top: number): Frame => ({
    page,
    x: contentX,
    width: page.width - contentX - MARGIN,
    top,
    bottom: page.height - BOTTOM_GUTTER,
  });

  const newPage = (): Frame => {
    const page = doc.addPage();
    background(page, pal);
    drawColumn(page, false);
    return makeFrame(page, MARGIN);
  };

  const page = doc.addPage();
  background(page, pal);
  drawColumn(page, true);

  const frame = makeFrame(page, MARGIN);
  let y = MARGIN + ctx.s(6);

  page.text(documentTitle(data), frame.x, y, {
    font: 'Helvetica-Bold', size: ctx.s(18), color: pal.text,
  });
  page.text(data.number, frame.x, y, {
    size: ctx.s(10), color: pal.muted, align: 'right', width: frame.width,
  });
  y += ctx.s(30);

  label(page, 'BILL TO', frame.x, y, ctx);
  y += ctx.s(15);
  const toBottom = stack(page, ctx, clientLines(data), frame.x, y, { first: pal.text, rest: pal.muted }, {
    firstSize: 10, boldFirst: true, width: frame.width * 0.55,
  });
  const detailBottom = rows(page, ctx, detailRows(data), frame.x + frame.width * 0.6, y - ctx.s(15), ctx.s(62), {
    label: pal.muted, value: pal.text,
  });

  y = Math.max(toBottom, detailBottom) + ctx.s(18);

  const table = lineItems(ctx, makeFrame(page, y), y, newPage);
  const summed = totals(ctx, table.frame, table.y, newPage);
  footer(ctx, { ...summed.frame, top: summed.y });
};

/**
 * Minimal — nothing filled, everything spaced.
 *
 * The only layout that draws no rectangles at all. It relies entirely on
 * hairlines and white space, which is why it ignores `tableHeader` and reads
 * `highlightTotal` as off by preference.
 */
const minimal: LayoutRenderer = (ctx) => {
  const { doc, data, pal, design } = ctx;
  const margin = MARGIN + ctx.s(18);

  const makeFrame = (page: PdfPage, top: number): Frame => ({
    page,
    x: margin,
    width: page.width - margin * 2,
    top,
    bottom: page.height - BOTTOM_GUTTER,
  });

  const newPage = (): Frame => {
    const page = doc.addPage();
    background(page, pal);
    return makeFrame(page, margin);
  };

  const page = doc.addPage();
  background(page, pal);
  const width = page.width - margin * 2;
  let y = margin + ctx.s(14);

  if (ctx.logo) {
    const box = drawLogo(page, ctx, margin, y, design.logo.size, ctx.s(44), width);
    y += box.height + ctx.s(18);
  }

  if (design.options.showBusinessName && data.from.businessName) {
    page.text(data.from.businessName, margin, y, {
      font: 'Helvetica-Bold', size: ctx.s(11), color: pal.text,
    });
  }
  // Set quietly — small, light, in the secondary colour — but NOT restyled.
  // An earlier version lowercased it, which is a layout editing the one piece
  // of wording that is not a layout's to edit: IRD and the ATO require the
  // document to be marked as a tax invoice, and how loudly that is set is the
  // only part of it a design gets a say in.
  page.text(documentTitle(data), margin, y, {
    size: ctx.s(10), color: pal.muted, align: 'right', width,
  });
  y += ctx.s(16);
  page.line(margin, y, page.width - margin, y, { color: pal.rule, width: 0.4 });
  y += ctx.s(28);

  // Three quiet columns of metadata.
  const columnWidth = width / 3 - 8;
  const metadata: Array<[string, string[]]> = [
    ['FROM', supplierLines(data)],
    ['BILL TO', clientLines(data)],
    [
      'DETAILS',
      [data.number, ...detailRows(data).map(([name, value]) => `${name}: ${value}`)],
    ],
  ];

  let metaBottom = y;
  metadata.forEach(([name, lines], i) => {
    const x = margin + (columnWidth + 12) * i;
    label(page, name, x, y, ctx);
    const bottom = stack(page, ctx, lines, x, y + ctx.s(15), { first: pal.text, rest: pal.muted }, {
      size: 8.5, firstSize: 9, width: columnWidth,
    });
    metaBottom = Math.max(metaBottom, bottom);
  });

  y = metaBottom + ctx.s(30);

  const table = lineItems(ctx, makeFrame(page, y), y, newPage);
  const summed = totals(ctx, table.frame, table.y, newPage);
  const payY = payment(ctx, summed.frame, summed.y + ctx.s(20), newPage);
  footer(ctx, { ...summed.frame, top: payY });
};

export const LAYOUT_RENDERERS: Record<InvoiceTemplateDesign['layout'], LayoutRenderer> = {
  classic,
  banner,
  sidebar,
  minimal,
};

/** Build the drawing context a layout runs against. */
export function layoutContext(
  doc: PdfDocument,
  data: InvoicePdfData,
  design: InvoiceTemplateDesign,
  logo: ImageHandle | null,
): LayoutContext {
  return {
    doc,
    data,
    design,
    pal: palette(design.theme),
    logo,
    s: (size: number) => size * design.typeScale,
  };
}

export { measureText, MARGIN };
