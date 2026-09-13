import { formatMoneyWithCode, type Cents, type Currency } from '~/lib/tax/money';

export interface InvoiceEmailData {
  invoiceNumber: string;
  clientName: string;
  businessName: string;
  senderName: string;
  total: Cents;
  currency: Currency;
  dueOn: string;
  viewUrl: string;
  payUrl?: string;
  customMessage?: string;
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-NZ', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

export function invoiceEmail(data: InvoiceEmailData): { subject: string; text: string; html: string } {
  const amount = formatMoneyWithCode(data.total, data.currency);
  const due = formatDate(data.dueOn);
  const subject = `Invoice ${data.invoiceNumber} from ${data.businessName} — ${amount}`;

  const intro =
    data.customMessage?.trim() ||
    `Please find invoice ${data.invoiceNumber} attached, for ${amount}, due ${due}.`;

  const text = [
    `Kia ora ${data.clientName},`,
    '',
    intro,
    '',
    `Invoice:  ${data.invoiceNumber}`,
    `Amount:   ${amount}`,
    `Due:      ${due}`,
    '',
    `View online: ${data.viewUrl}`,
    data.payUrl ? `Pay by card: ${data.payUrl}` : '',
    '',
    'The PDF is attached, and bank details are on it.',
    '',
    'Ngā mihi,',
    data.senderName,
    data.businessName,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  // Email HTML is deliberately table-free and inline-styled — it has to
  // survive Outlook, which supports roughly none of the last decade of CSS.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e2;border-radius:12px;padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;">Kia ora ${escapeHtml(data.clientName)},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>

    <div style="background:#f6f6f4;border-radius:8px;padding:16px;margin:0 0 20px;">
      <p style="margin:0 0 6px;font-size:13px;color:#666;">Invoice ${escapeHtml(data.invoiceNumber)}</p>
      <p style="margin:0 0 4px;font-size:26px;font-weight:600;">${escapeHtml(amount)}</p>
      <p style="margin:0;font-size:13px;color:#666;">Due ${escapeHtml(due)}</p>
    </div>

    <p style="margin:0 0 20px;">
      <a href="${escapeAttr(data.viewUrl)}" style="display:inline-block;background:#1f5c4d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:500;">View invoice</a>
      ${data.payUrl ? `<a href="${escapeAttr(data.payUrl)}" style="display:inline-block;margin-left:8px;border:1px solid #d5d5d2;color:#1a1a1a;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;">Pay by card</a>` : ''}
    </p>

    <p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.55;">The PDF is attached, and bank details are on it.</p>

    <p style="margin:0;font-size:15px;">Ngā mihi,<br>${escapeHtml(data.senderName)}<br>
      <span style="color:#666;">${escapeHtml(data.businessName)}</span></p>
  </div>
</body></html>`;

  return { subject, text, html };
}

export function reminderEmail(
  data: InvoiceEmailData & { daysOverdue: number },
): { subject: string; text: string; html: string } {
  const amount = formatMoneyWithCode(data.total, data.currency);
  const overdue = data.daysOverdue > 0;

  const subject = overdue
    ? `Overdue: invoice ${data.invoiceNumber} — ${amount}`
    : `Reminder: invoice ${data.invoiceNumber} due soon — ${amount}`;

  const intro = overdue
    ? `Invoice ${data.invoiceNumber} for ${amount} was due ${formatDate(data.dueOn)}, ${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'} ago. If it is already on its way, ignore this.`
    : `A reminder that invoice ${data.invoiceNumber} for ${amount} falls due on ${formatDate(data.dueOn)}.`;

  const base = invoiceEmail({ ...data, customMessage: intro });
  return { subject, text: base.text, html: base.html };
}

export interface MagicLinkEmailData {
  /** Who the link belongs to, for the greeting. */
  name: string;
  appName: string;
  url: string;
  expiresMinutes: number;
  /** Where the link was asked for, so an unexpected mail is recognisable. */
  requestedIp?: string | null;
}

/**
 * The sign-in link.
 *
 * Kept deliberately plain: no tracking pixel, no shortener, no redirect hop.
 * Anything that rewrites the URL will be fetched by a mail scanner and burn
 * the one-shot token before the recipient ever clicks it.
 */
export function magicLinkEmail(data: MagicLinkEmailData): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Your sign-in link for ${data.appName}`;
  const from = data.requestedIp ? ` from ${data.requestedIp}` : '';

  const text = [
    `Kia ora ${data.name},`,
    '',
    `Here is your sign-in link for ${data.appName}. It works once and expires in ${data.expiresMinutes} minutes.`,
    '',
    data.url,
    '',
    `If you did not ask for this${from}, you can ignore this email — the link is useless without your inbox, and nothing has changed on your account.`,
    '',
    data.appName,
  ].join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e2;border-radius:12px;padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;">Kia ora ${escapeHtml(data.name)},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">Here is your sign-in link for ${escapeHtml(data.appName)}. It works once and expires in ${data.expiresMinutes} minutes.</p>

    <p style="margin:0 0 20px;">
      <a href="${escapeAttr(data.url)}" style="display:inline-block;background:#1f5c4d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:500;">Sign in</a>
    </p>

    <p style="margin:0 0 20px;font-size:13px;color:#666;line-height:1.55;word-break:break-all;">If the button does not work, paste this into your browser:<br>${escapeHtml(data.url)}</p>

    <p style="margin:0;font-size:14px;color:#666;line-height:1.55;">If you did not ask for this${escapeHtml(from)}, you can ignore this email — the link is useless without your inbox, and nothing has changed on your account.</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */

export interface QuoteEmailData {
  quoteNumber: string;
  title: string;
  clientName: string;
  businessName: string;
  senderName: string;
  total: Cents;
  currency: Currency;
  /** ISO date the quote lapses, or null when it does not. */
  expiresOn: string | null;
  viewUrl: string;
  customMessage?: string;
}

/**
 * A quote, not an invoice.
 *
 * The wording is careful about that: nothing here asks for money or mentions
 * bank details, and the call to action is to read and decide rather than to
 * pay. A quote that reads like an invoice gets paid by mistake, and that is a
 * worse problem than one that gets ignored.
 */
export function quoteEmail(data: QuoteEmailData): { subject: string; text: string; html: string } {
  const amount = formatMoneyWithCode(data.total, data.currency);
  const subject = `Quote ${data.quoteNumber} from ${data.businessName} — ${data.title}`;

  const validity = data.expiresOn
    ? `This quote holds until ${formatDate(data.expiresOn)}.`
    : 'This quote does not have an expiry date.';

  const intro =
    data.customMessage?.trim() ||
    `Here is a quote for ${data.title}, at ${amount} including any GST. ${validity}`;

  const text = [
    `Kia ora ${data.clientName},`,
    '',
    intro,
    '',
    `Quote:  ${data.quoteNumber}`,
    `Amount: ${amount}`,
    data.expiresOn ? `Holds until: ${formatDate(data.expiresOn)}` : '',
    '',
    `Read it and accept or decline here: ${data.viewUrl}`,
    '',
    'The PDF is attached. Nothing is payable until the work is agreed and invoiced.',
    '',
    'Ngā mihi,',
    data.senderName,
    data.businessName,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e2;border-radius:12px;padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;">Kia ora ${escapeHtml(data.clientName)},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>

    <div style="background:#f6f6f4;border-radius:8px;padding:16px;margin:0 0 20px;">
      <p style="margin:0 0 6px;font-size:13px;color:#666;">Quote ${escapeHtml(data.quoteNumber)} · ${escapeHtml(data.title)}</p>
      <p style="margin:0 0 4px;font-size:26px;font-weight:600;">${escapeHtml(amount)}</p>
      ${data.expiresOn ? `<p style="margin:0;font-size:13px;color:#666;">Holds until ${escapeHtml(formatDate(data.expiresOn))}</p>` : ''}
    </div>

    <p style="margin:0 0 20px;">
      <a href="${escapeAttr(data.viewUrl)}" style="display:inline-block;background:#1f5c4d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:500;">Read the quote</a>
    </p>

    <p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.55;">The PDF is attached. Nothing is payable until the work is agreed and invoiced.</p>

    <p style="margin:0;font-size:15px;">Ngā mihi,<br>${escapeHtml(data.senderName)}<br>
      <span style="color:#666;">${escapeHtml(data.businessName)}</span></p>
  </div>
</body></html>`;

  return { subject, text, html };
}
