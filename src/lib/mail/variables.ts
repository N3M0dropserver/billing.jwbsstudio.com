/**
 * The variables a template may use, and how their values are produced.
 *
 * This is the contract between the editor and the send path. The editor shows
 * the catalogue as an insertable palette; the send path builds the values map
 * from real records. Both read from here, so a variable cannot exist in one
 * and not the other.
 *
 * Money and dates are formatted with the same helpers the PDF uses, so a
 * figure in the email body always matches the figure on the attached invoice.
 * A client noticing a one-cent discrepancy between the two is a support
 * conversation nobody wants.
 */

import { formatMoneyWithCode, type Cents, type Currency } from '~/lib/tax/money';
import type { TemplateValues } from '~/lib/mail/render';

export type TemplateKind = 'invoice' | 'reminder' | 'proposal' | 'general';

export interface VariableDef {
  /** The token as written in a template, without braces. */
  key: string;
  label: string;
  /** What it looks like, shown in the palette and used for preview. */
  sample: string;
}

export interface VariableGroup {
  label: string;
  variables: VariableDef[];
}

const SENDER: VariableGroup = {
  label: 'You',
  variables: [
    { key: 'business.name', label: 'Business name', sample: 'JWBS Studio' },
    { key: 'business.email', label: 'Business email', sample: 'hello@jwbsstudio.com' },
    { key: 'business.phone', label: 'Business phone', sample: '+64 21 555 0100' },
    { key: 'business.website', label: 'Website', sample: 'jwbsstudio.com' },
    { key: 'sender.name', label: 'Your name', sample: 'Zac' },
  ],
};

/**
 * The optional note typed on the send form, at send time.
 *
 * A template that includes it controls where it appears; a template that
 * leaves it out silently drops whatever was typed, which is why the send form
 * says so.
 */
const THIS_SEND: VariableGroup = {
  label: 'This send',
  variables: [
    {
      key: 'message',
      label: 'Note typed when sending',
      sample: 'Thanks for a great project — the final invoice is attached.',
    },
  ],
};

const CLIENT: VariableGroup = {
  label: 'Client',
  variables: [
    { key: 'client.name', label: 'Client name', sample: 'Kōwhai Coffee Roasters' },
    { key: 'client.firstName', label: 'Client first name', sample: 'Kōwhai' },
    { key: 'client.email', label: 'Client email', sample: 'accounts@kowhai.co.nz' },
  ],
};

const INVOICE: VariableGroup = {
  label: 'Invoice',
  variables: [
    { key: 'invoice.number', label: 'Invoice number', sample: 'INV-0042' },
    { key: 'invoice.total', label: 'Total', sample: 'NZ$1,437.50' },
    { key: 'invoice.amountDue', label: 'Amount still owing', sample: 'NZ$1,437.50' },
    { key: 'invoice.amountPaid', label: 'Amount paid', sample: 'NZ$0.00' },
    { key: 'invoice.issuedOn', label: 'Issue date', sample: '1 September 2026' },
    { key: 'invoice.dueOn', label: 'Due date', sample: '15 September 2026' },
    { key: 'invoice.reference', label: 'Your reference', sample: 'PO-8891' },
    { key: 'invoice.daysOverdue', label: 'Days overdue', sample: '7' },
    { key: 'links.view', label: 'Link — view invoice', sample: 'https://billing.jwbsstudio.com/pay/…' },
    { key: 'links.pay', label: 'Link — pay by card', sample: 'https://billing.jwbsstudio.com/pay/…' },
  ],
};

const PROPOSAL: VariableGroup = {
  label: 'Proposal',
  variables: [
    { key: 'proposal.title', label: 'Proposal title', sample: 'Website refresh' },
    { key: 'proposal.amount', label: 'Quoted amount', sample: 'NZ$4,200.00' },
    { key: 'proposal.expiresOn', label: 'Valid until', sample: '30 September 2026' },
    { key: 'links.proposal', label: 'Link — view proposal', sample: 'https://billing.jwbsstudio.com/p/…' },
  ],
};

export const VARIABLE_GROUPS: Record<TemplateKind, VariableGroup[]> = {
  invoice: [CLIENT, INVOICE, SENDER, THIS_SEND],
  reminder: [CLIENT, INVOICE, SENDER, THIS_SEND],
  proposal: [CLIENT, PROPOSAL, SENDER, THIS_SEND],
  general: [CLIENT, SENDER, THIS_SEND],
};

export const KIND_LABELS: Record<TemplateKind, string> = {
  invoice: 'Invoice',
  reminder: 'Payment reminder',
  proposal: 'Proposal',
  general: 'General',
};

export const TEMPLATE_KINDS = Object.keys(KIND_LABELS) as TemplateKind[];

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as string[]).includes(value);
}

/** Every variable available for a kind, flattened. */
export function variablesFor(kind: TemplateKind): VariableDef[] {
  return VARIABLE_GROUPS[kind].flatMap((group) => group.variables);
}

/**
 * Stand-in values, for the editor preview and the test send. Real enough that
 * the layout is representative — a preview full of `Lorem` tells you nothing
 * about whether a long client name wraps badly.
 */
export function sampleValues(kind: TemplateKind): TemplateValues {
  return Object.fromEntries(variablesFor(kind).map((v) => [v.key, v.sample]));
}

export const formatEmailDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-NZ', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

/** The leading word of a name, for a less formal greeting. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

export interface InvoiceVariableInput {
  invoiceNumber: string;
  clientName: string;
  clientEmail: string;
  total: Cents;
  amountPaid: Cents;
  currency: Currency;
  issuedOn: string;
  dueOn: string;
  reference: string;
  daysOverdue: number;
  viewUrl: string;
  payUrl?: string;
  businessName: string;
  businessEmail: string;
  businessPhone: string;
  businessWebsite: string;
  senderName: string;
}

export function invoiceValues(input: InvoiceVariableInput): TemplateValues {
  const money = (cents: Cents) => formatMoneyWithCode(cents, input.currency);

  return {
    'client.name': input.clientName,
    'client.firstName': firstName(input.clientName),
    'client.email': input.clientEmail,

    'invoice.number': input.invoiceNumber,
    'invoice.total': money(input.total),
    'invoice.amountDue': money(input.total - input.amountPaid),
    'invoice.amountPaid': money(input.amountPaid),
    'invoice.issuedOn': formatEmailDate(input.issuedOn),
    'invoice.dueOn': formatEmailDate(input.dueOn),
    'invoice.reference': input.reference,
    // Clamped: a future-dated invoice is not "-4 days overdue".
    'invoice.daysOverdue': String(Math.max(input.daysOverdue, 0)),

    'links.view': input.viewUrl,
    'links.pay': input.payUrl ?? input.viewUrl,

    'business.name': input.businessName,
    'business.email': input.businessEmail,
    'business.phone': input.businessPhone,
    'business.website': input.businessWebsite,
    'sender.name': input.senderName,
  };
}
