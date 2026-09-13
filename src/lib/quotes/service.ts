/**
 * Quotes, and turning an accepted one into an invoice.
 *
 * A quote closes the loop at the front of a job rather than only at the end,
 * and it means the terms the client agreed to are the terms on the invoice —
 * automatically, rather than by being retyped from an email thread.
 *
 * It is priced through the same GST engine and the same arithmetic as an
 * invoice, and rendered through the same PDF writer. The differences are
 * exactly three: it has its own number series, its second date is a lapse
 * date rather than a payment date, and it can be accepted.
 */

import { and, eq, desc } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import {
  proposals,
  proposalLines,
  invoices,
  invoiceLines,
  settings as settingsTable,
  clients,
  activityLog,
  type Proposal,
  type ProposalLine,
  type Client,
  type Settings,
} from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';
import { calculateInvoice, formatInvoiceNumber, dueDateFrom, type LineInput } from '~/lib/invoices/calculate';
import { resolveGstTreatment } from '~/lib/invoices/service';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';
import type { GstTreatment } from '~/lib/tax/gst';

export interface QuoteWithLines extends Proposal {
  lines: ProposalLine[];
  client: Client | null;
}

export async function getQuote(
  db: Db,
  userId: string,
  quoteId: string,
): Promise<QuoteWithLines | null> {
  const rows = await db
    .select({ quote: proposals, client: clients })
    .from(proposals)
    .leftJoin(clients, eq(proposals.clientId, clients.id))
    .where(and(eq(proposals.id, quoteId), eq(proposals.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lines = await db
    .select()
    .from(proposalLines)
    .where(eq(proposalLines.proposalId, quoteId))
    .orderBy(proposalLines.position);

  return { ...row.quote, lines, client: row.client };
}

/** By public token, for the unauthenticated view-and-accept page. */
export async function getQuoteByToken(db: Db, token: string): Promise<QuoteWithLines | null> {
  const rows = await db
    .select({ quote: proposals, client: clients })
    .from(proposals)
    .leftJoin(clients, eq(proposals.clientId, clients.id))
    .where(eq(proposals.publicToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lines = await db
    .select()
    .from(proposalLines)
    .where(eq(proposalLines.proposalId, row.quote.id))
    .orderBy(proposalLines.position);

  return { ...row.quote, lines, client: row.client };
}

export interface SaveQuoteInput {
  userId: string;
  clientId: string | null;
  title: string;
  body?: string;
  currency: 'NZD' | 'AUD';
  jurisdiction: 'NZ' | 'AU';
  gstTreatment?: GstTreatment;
  fxRateToResidence?: number;
  reference?: string;
  notes?: string;
  terms?: string;
  /** Days the quote stays open. */
  validDays?: number;
  lines: Array<LineInput & { unit?: string }>;
}

function priceQuote(
  setting: Settings,
  client: Client | null,
  input: Pick<SaveQuoteInput, 'jurisdiction' | 'gstTreatment' | 'lines'>,
  issuedOn: string,
) {
  const treatment =
    input.gstTreatment ?? resolveGstTreatment(setting, client, input.jurisdiction);
  const taxYear =
    input.jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${issuedOn}T00:00:00Z`));

  return {
    treatment,
    totals: calculateInvoice(input.lines, {
      jurisdiction: input.jurisdiction,
      year: taxYear,
      treatment,
    }),
  };
}

export async function createQuote(
  db: Db,
  setting: Settings,
  input: SaveQuoteInput,
): Promise<{ id: string; number: string }> {
  const client = input.clientId
    ? (
        await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, input.clientId), eq(clients.userId, input.userId)))
          .limit(1)
      )[0] ?? null
    : null;

  const now = new Date().toISOString();
  const issuedOn = now.slice(0, 10);
  const { treatment, totals } = priceQuote(setting, client, input, issuedOn);

  const number = formatInvoiceNumber(setting.quoteNumberPrefix, setting.quoteNextNumber);
  const quoteId = newId();
  const validDays = input.validDays ?? setting.quoteValidDays;

  const statements: unknown[] = [
    db.insert(proposals).values({
      id: quoteId,
      userId: input.userId,
      clientId: input.clientId,
      number,
      title: input.title,
      body: input.body ?? '',
      status: 'draft',
      amount: totals.subtotal,
      currency: input.currency,
      jurisdiction: input.jurisdiction,
      gstTreatment: treatment,
      subtotal: totals.subtotal,
      gstAmount: totals.gstAmount,
      total: totals.total,
      fxRateToResidence:
        Number.isFinite(input.fxRateToResidence) && (input.fxRateToResidence ?? 0) > 0
          ? input.fxRateToResidence!
          : 1,
      reference: input.reference ?? '',
      notes: input.notes ?? '',
      terms: input.terms ?? setting.invoiceFooter,
      expiresOn: dueDateFrom(issuedOn, validDays),
      publicToken: newToken(24),
      createdAt: now,
      updatedAt: now,
    }),

    // Reserve the number immediately, exactly as an invoice does.
    db
      .update(settingsTable)
      .set({ quoteNextNumber: setting.quoteNextNumber + 1, updatedAt: now })
      .where(eq(settingsTable.id, setting.id)),
  ];

  totals.lines.forEach((line, index) => {
    statements.push(
      db.insert(proposalLines).values({
        id: newId(),
        proposalId: quoteId,
        position: index,
        description: line.description,
        quantity: line.quantity,
        unit: input.lines[index]?.unit ?? 'hours',
        unitPrice: line.unitPrice,
        discount: line.discount ?? 0,
        lineTotal: line.lineTotal,
        taxable: line.taxable !== false,
      }),
    );
  });

  statements.push(
    db.insert(activityLog).values({
      id: newId(),
      userId: input.userId,
      action: 'quote.created',
      entityType: 'proposal',
      entityId: quoteId,
      detail: JSON.stringify({ number, total: totals.total }),
      createdAt: now,
    }),
  );

  await db.batch(statements as never);
  return { id: quoteId, number };
}

export type QuoteEditRefusal = 'accepted' | 'converted' | 'declined';

export const QUOTE_REFUSAL_MESSAGE: Record<QuoteEditRefusal, string> = {
  accepted:
    'The client has accepted this quote. Changing the figures now would change what they agreed to — raise a new quote instead.',
  converted: 'This quote has already become an invoice. Edit the invoice.',
  declined: 'This quote was declined. Raise a new one rather than reopening it.',
};

export function quoteEditability(
  quote: Pick<Proposal, 'status' | 'convertedInvoiceId'>,
): { canEdit: true } | { canEdit: false; reason: QuoteEditRefusal } {
  if (quote.convertedInvoiceId) return { canEdit: false, reason: 'converted' };
  if (quote.status === 'accepted') return { canEdit: false, reason: 'accepted' };
  if (quote.status === 'declined') return { canEdit: false, reason: 'declined' };
  return { canEdit: true };
}

export async function updateQuote(
  db: Db,
  setting: Settings,
  quote: Proposal,
  input: SaveQuoteInput,
): Promise<void> {
  const client = input.clientId
    ? (
        await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, input.clientId), eq(clients.userId, quote.userId)))
          .limit(1)
      )[0] ?? null
    : null;

  const issuedOn = quote.createdAt.slice(0, 10);
  const { treatment, totals } = priceQuote(setting, client, input, issuedOn);
  const now = new Date().toISOString();

  const statements: unknown[] = [
    db.delete(proposalLines).where(eq(proposalLines.proposalId, quote.id)),
  ];

  totals.lines.forEach((line, index) => {
    statements.push(
      db.insert(proposalLines).values({
        id: newId(),
        proposalId: quote.id,
        position: index,
        description: line.description,
        quantity: line.quantity,
        unit: input.lines[index]?.unit ?? 'hours',
        unitPrice: line.unitPrice,
        discount: line.discount ?? 0,
        lineTotal: line.lineTotal,
        taxable: line.taxable !== false,
      }),
    );
  });

  statements.push(
    db
      .update(proposals)
      .set({
        clientId: input.clientId,
        title: input.title,
        body: input.body ?? quote.body,
        currency: input.currency,
        jurisdiction: input.jurisdiction,
        gstTreatment: treatment,
        amount: totals.subtotal,
        subtotal: totals.subtotal,
        gstAmount: totals.gstAmount,
        total: totals.total,
        reference: input.reference ?? quote.reference,
        notes: input.notes ?? quote.notes,
        terms: input.terms ?? quote.terms,
        expiresOn: input.validDays
          ? dueDateFrom(issuedOn, input.validDays)
          : quote.expiresOn,
        updatedAt: now,
      })
      .where(eq(proposals.id, quote.id)),
  );

  await db.batch(statements as never);
}

/**
 * Has this quote lapsed?
 *
 * Derived on read rather than stored, for the same reason an invoice's
 * overdue status is: it is a function of time, and a stored flag would need a
 * job to keep it true.
 */
export function hasLapsed(quote: Pick<Proposal, 'expiresOn' | 'status'>, today = new Date().toISOString().slice(0, 10)): boolean {
  if (quote.status === 'accepted' || quote.status === 'declined') return false;
  return Boolean(quote.expiresOn && quote.expiresOn < today);
}

export interface AcceptanceMeta {
  name: string;
  ip: string | null;
}

/**
 * Record a client's acceptance.
 *
 * Deliberately idempotent and deliberately narrow: it moves the quote to
 * accepted and records who said so, and does not create the invoice. Turning
 * an accepted quote into an invoice reserves an invoice number and starts a
 * payment clock, and that is the sender's decision to make, not something a
 * click from outside should trigger.
 */
export async function acceptQuote(
  db: Db,
  quote: Proposal,
  meta: AcceptanceMeta,
): Promise<{ ok: boolean; reason?: string }> {
  if (quote.status === 'accepted') return { ok: true };
  if (quote.status === 'declined') return { ok: false, reason: 'This quote was declined.' };
  if (hasLapsed(quote)) return { ok: false, reason: 'This quote has expired.' };
  if (quote.status === 'draft') return { ok: false, reason: 'This quote has not been sent yet.' };

  const now = new Date().toISOString();
  await db.batch([
    db
      .update(proposals)
      .set({
        status: 'accepted',
        respondedAt: now,
        acceptedName: meta.name.slice(0, 200),
        acceptedIp: meta.ip,
        updatedAt: now,
      })
      .where(eq(proposals.id, quote.id)),
    db.insert(activityLog).values({
      id: newId(),
      userId: quote.userId,
      action: 'quote.accepted',
      entityType: 'proposal',
      entityId: quote.id,
      detail: JSON.stringify({ number: quote.number, by: meta.name, total: quote.total }),
      createdAt: now,
    }),
  ] as never);

  return { ok: true };
}

export async function declineQuote(
  db: Db,
  quote: Proposal,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .update(proposals)
      .set({
        status: 'declined',
        respondedAt: now,
        declineReason: reason.slice(0, 500),
        updatedAt: now,
      })
      .where(eq(proposals.id, quote.id)),
    db.insert(activityLog).values({
      id: newId(),
      userId: quote.userId,
      action: 'quote.declined',
      entityType: 'proposal',
      entityId: quote.id,
      detail: JSON.stringify({ number: quote.number, reason }),
      createdAt: now,
    }),
  ] as never);
}

/**
 * Turn an accepted quote into an invoice.
 *
 * The lines are copied as they were priced, not re-derived, so the invoice
 * says exactly what the client agreed to — even if a rate or a default has
 * changed since. The GST treatment travels with them for the same reason.
 *
 * One quote becomes at most one invoice: the link is recorded on the quote
 * and checked before anything is created, so a double submit or a second
 * click cannot raise two invoices for one job.
 */
export async function convertQuoteToInvoice(
  db: Db,
  setting: Settings,
  quote: QuoteWithLines,
): Promise<{ ok: false; reason: string } | { ok: true; invoiceId: string; number: string }> {
  if (quote.convertedInvoiceId) {
    return { ok: false, reason: 'This quote has already become an invoice.' };
  }
  if (quote.status !== 'accepted') {
    return { ok: false, reason: 'Only an accepted quote can become an invoice.' };
  }
  if (quote.lines.length === 0) {
    return { ok: false, reason: 'This quote has no lines on it.' };
  }

  const now = new Date().toISOString();
  const issuedOn = now.slice(0, 10);
  const invoiceId = newId();
  const number = formatInvoiceNumber(setting.invoiceNumberPrefix, setting.invoiceNextNumber);

  const dueOn = dueDateFrom(
    issuedOn,
    quote.client?.paymentTermsDays ?? setting.defaultPaymentTermsDays,
  );

  const statements: unknown[] = [
    db.insert(invoices).values({
      id: invoiceId,
      userId: quote.userId,
      clientId: quote.clientId,
      number,
      status: 'draft',
      isManualEntry: false,
      issuedOn,
      dueOn,
      currency: quote.currency,
      jurisdiction: quote.jurisdiction,
      gstTreatment: quote.gstTreatment,
      subtotal: quote.subtotal,
      gstAmount: quote.gstAmount,
      total: quote.total,
      amountPaid: 0,
      fxRateToResidence: quote.fxRateToResidence,
      reference: quote.reference || quote.number,
      notes: quote.notes,
      terms: quote.terms,
      publicToken: newToken(24),
      createdAt: now,
      updatedAt: now,
    }),

    db
      .update(settingsTable)
      .set({ invoiceNextNumber: setting.invoiceNextNumber + 1, updatedAt: now })
      .where(eq(settingsTable.id, setting.id)),
  ];

  quote.lines.forEach((line, index) => {
    statements.push(
      db.insert(invoiceLines).values({
        id: newId(),
        invoiceId,
        position: index,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        discount: line.discount,
        lineTotal: line.lineTotal,
        taxable: line.taxable,
      }),
    );
  });

  statements.push(
    db
      .update(proposals)
      .set({ convertedInvoiceId: invoiceId, updatedAt: now })
      .where(eq(proposals.id, quote.id)),
    db.insert(activityLog).values({
      id: newId(),
      userId: quote.userId,
      action: 'quote.converted',
      entityType: 'invoice',
      entityId: invoiceId,
      detail: JSON.stringify({ quote: quote.number, invoice: number, total: quote.total }),
      createdAt: now,
    }),
  );

  await db.batch(statements as never);
  return { ok: true, invoiceId, number };
}

export async function listQuotes(db: Db, userId: string, limit = 100) {
  return db
    .select({ quote: proposals, clientName: clients.name })
    .from(proposals)
    .leftJoin(clients, eq(proposals.clientId, clients.id))
    .where(eq(proposals.userId, userId))
    .orderBy(desc(proposals.createdAt))
    .limit(limit);
}
