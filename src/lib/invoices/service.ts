/**
 * Invoice operations that touch more than one table.
 *
 * D1 has no interactive transactions, so multi-statement work goes through
 * `db.batch()`, which is atomic. Anything that cannot be batched is ordered
 * so that a failure leaves the data recoverable rather than half-written.
 */

import { and, eq, sql, desc } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import {
  invoices, invoiceLines, payments, clients, settings, timeEntries, activityLog,
  type Invoice, type InvoiceLine, type Client, type Settings,
} from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';
import { calculateInvoice, formatInvoiceNumber, dueDateFrom, deriveStatus, type LineInput } from './calculate';
import { assessExportTreatment, type GstTreatment } from '~/lib/tax/gst';
import { nzTaxYearFor, auFinancialYearFor } from '~/lib/tax/engine';
import type { Cents } from '~/lib/tax/money';

export interface InvoiceWithLines extends Invoice {
  lines: InvoiceLine[];
  client: Client | null;
}

export async function getInvoice(
  db: Db,
  userId: string,
  invoiceId: string,
): Promise<InvoiceWithLines | null> {
  const rows = await db
    .select({ invoice: invoices, client: clients })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(invoiceLines.position);

  return { ...row.invoice, lines, client: row.client };
}

/** Look an invoice up by its public token, for the unauthenticated pay page. */
export async function getInvoiceByToken(
  db: Db,
  token: string,
): Promise<InvoiceWithLines | null> {
  const rows = await db
    .select({ invoice: invoices, client: clients })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(eq(invoices.publicToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, row.invoice.id))
    .orderBy(invoiceLines.position);

  return { ...row.invoice, lines, client: row.client };
}

/**
 * Decide the GST treatment for an invoice.
 *
 * A client can pin a treatment explicitly; otherwise it is derived from where
 * they are and whether you are registered. The derivation is conservative —
 * anything it is not sure about comes back standard-rated.
 */
export function resolveGstTreatment(
  setting: Settings,
  client: Pick<Client, 'country' | 'gstTreatment'> | null,
  jurisdiction: 'NZ' | 'AU',
): GstTreatment {
  const registered =
    jurisdiction === 'NZ' ? setting.nzGstRegistered : setting.auGstRegistered;

  if (!registered) return 'not-registered';
  if (!client) return 'standard';

  if (client.gstTreatment !== 'auto') return client.gstTreatment as GstTreatment;

  const assessment = assessExportTreatment({
    supplierJurisdiction: jurisdiction,
    supplierRegistered: registered,
    clientCountry: client.country,
    clientPresentInSupplierCountry: false,
    connectedWithLocalLand: false,
  });
  return assessment.treatment;
}

export interface CreateInvoiceInput {
  userId: string;
  clientId: string | null;
  issuedOn: string;
  dueOn?: string;
  currency: 'NZD' | 'AUD';
  jurisdiction: 'NZ' | 'AU';
  gstTreatment?: GstTreatment;
  reference?: string;
  notes?: string;
  terms?: string;
  lines: Array<LineInput & { unit?: string }>;
  isManualEntry?: boolean;
  status?: 'draft' | 'sent';
  /** Time entries to mark billed against this invoice. */
  timeEntryIds?: string[];
  /**
   * Rate converting this invoice into the tax-residence currency, as it stood
   * on the issue date. 1 when the invoice is already in that currency.
   * Stored rather than looked up later, because the rate on the day is the
   * one the return uses.
   */
  fxRateToResidence?: number;
}

export async function createInvoice(
  db: Db,
  setting: Settings,
  input: CreateInvoiceInput,
): Promise<{ id: string; number: string }> {
  // Scoped to the owner, like every other lookup in this file. An invoice
  // must never be raised against another user's client record.
  const client = input.clientId
    ? (
        await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, input.clientId), eq(clients.userId, input.userId)))
          .limit(1)
      )[0] ?? null
    : null;

  const treatment =
    input.gstTreatment ?? resolveGstTreatment(setting, client, input.jurisdiction);

  const taxYear =
    input.jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${input.issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${input.issuedOn}T00:00:00Z`));

  const totals = calculateInvoice(input.lines, {
    jurisdiction: input.jurisdiction,
    year: taxYear,
    treatment,
  });

  const number = formatInvoiceNumber(setting.invoiceNumberPrefix, setting.invoiceNextNumber);
  const dueOn =
    input.dueOn ??
    dueDateFrom(input.issuedOn, client?.paymentTermsDays ?? setting.defaultPaymentTermsDays);

  const invoiceId = newId();
  const now = new Date().toISOString();

  // D1 batches are atomic. Typed loosely because drizzle's batch signature
  // is a non-empty tuple, which an array built up in a loop cannot satisfy.
  const statements: unknown[] = [
    db.insert(invoices).values({
      id: invoiceId,
      userId: input.userId,
      clientId: input.clientId,
      number,
      status: input.status ?? 'draft',
      isManualEntry: input.isManualEntry ?? false,
      issuedOn: input.issuedOn,
      dueOn,
      currency: input.currency,
      jurisdiction: input.jurisdiction,
      gstTreatment: treatment,
      subtotal: totals.subtotal,
      gstAmount: totals.gstAmount,
      total: totals.total,
      amountPaid: 0,
      fxRateToResidence:
        Number.isFinite(input.fxRateToResidence) && (input.fxRateToResidence ?? 0) > 0
          ? input.fxRateToResidence!
          : 1,
      reference: input.reference ?? '',
      notes: input.notes ?? '',
      terms: input.terms ?? setting.invoiceFooter,
      publicToken: newToken(24),
      createdAt: now,
      updatedAt: now,
    }),

    // Reserve the number immediately so two invoices can never share one.
    db
      .update(settings)
      .set({ invoiceNextNumber: setting.invoiceNextNumber + 1, updatedAt: now })
      .where(eq(settings.id, setting.id)),
  ];

  totals.lines.forEach((line, index) => {
    statements.push(
      db.insert(invoiceLines).values({
        id: newId(),
        invoiceId,
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

  for (const timeEntryId of input.timeEntryIds ?? []) {
    statements.push(
      db
        .update(timeEntries)
        .set({ billed: true, invoiceId, updatedAt: now })
        .where(and(eq(timeEntries.id, timeEntryId), eq(timeEntries.userId, input.userId))),
    );
  }

  statements.push(
    db.insert(activityLog).values({
      id: newId(),
      userId: input.userId,
      action: 'invoice.created',
      entityType: 'invoice',
      entityId: invoiceId,
      detail: JSON.stringify({ number, total: totals.total }),
      createdAt: now,
    }),
  );

  await db.batch(statements as never);
  return { id: invoiceId, number };
}

/**
 * Whether an invoice may still be changed, and why not when it may not.
 *
 * An invoice is a document someone else has been given. Once money has been
 * recorded against it, or it has been voided, editing it rewrites a record
 * that two parties are relying on — the remedy there is a credit note or a
 * second invoice, not a quiet amendment. Everything short of that is fair
 * game, because the alternative has been no remedy at all: a typo in an
 * amount meant opening a SQL console against production.
 */
export type EditRefusal = 'has-payments' | 'void' | 'written-off';

export function editability(
  invoice: Pick<Invoice, 'status' | 'amountPaid'>,
): { canEdit: true } | { canEdit: false; reason: EditRefusal } {
  if (invoice.status === 'void') return { canEdit: false, reason: 'void' };
  if (invoice.status === 'written-off') return { canEdit: false, reason: 'written-off' };
  if (invoice.amountPaid > 0) return { canEdit: false, reason: 'has-payments' };
  return { canEdit: true };
}

export const EDIT_REFUSAL_MESSAGE: Record<EditRefusal, string> = {
  'has-payments':
    'This invoice has payments recorded against it, so its figures are part of a settled record. Raise a credit note or a second invoice for the difference instead.',
  void: 'This invoice has been voided. Voiding is deliberately final — raise a new one.',
  'written-off':
    'This invoice has been written off as a bad debt. Reverse the write-off first if you need to change it.',
};

export interface UpdateInvoiceInput {
  clientId?: string | null;
  issuedOn?: string;
  dueOn?: string;
  currency?: 'NZD' | 'AUD';
  jurisdiction?: 'NZ' | 'AU';
  gstTreatment?: GstTreatment;
  fxRateToResidence?: number;
  reference?: string;
  notes?: string;
  terms?: string;
  lines: Array<LineInput & { unit?: string }>;
  /** Move a draft to sent. Never moves a sent invoice back to draft. */
  finalise?: boolean;
}

/**
 * Rewrite an invoice's content and recompute its totals.
 *
 * The number is never reissued — it is the thing the client and their
 * bookkeeper quote at each other — and neither is the public token, so a link
 * already in someone's inbox keeps working and shows the corrected document.
 */
export async function updateInvoice(
  db: Db,
  setting: Settings,
  invoice: Invoice,
  input: UpdateInvoiceInput,
): Promise<void> {
  const jurisdiction = input.jurisdiction ?? invoice.jurisdiction;
  const issuedOn = input.issuedOn || invoice.issuedOn;

  const client =
    input.clientId !== undefined && input.clientId
      ? (
          await db
            .select()
            .from(clients)
            .where(and(eq(clients.id, input.clientId), eq(clients.userId, invoice.userId)))
            .limit(1)
        )[0] ?? null
      : null;

  const treatment = input.gstTreatment ?? resolveGstTreatment(setting, client, jurisdiction);

  const taxYear =
    jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${issuedOn}T00:00:00Z`));

  const totals = calculateInvoice(input.lines, { jurisdiction, year: taxYear, treatment });

  const currency = input.currency ?? invoice.currency;
  const residenceCurrency = setting.taxResidence === 'NZ' ? 'NZD' : 'AUD';
  const fxRateToResidence =
    currency === residenceCurrency
      ? 1
      : Number.isFinite(input.fxRateToResidence) && (input.fxRateToResidence ?? 0) > 0
        ? input.fxRateToResidence!
        : invoice.fxRateToResidence;

  const now = new Date().toISOString();
  const statements: unknown[] = [
    db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)),
  ];

  totals.lines.forEach((line, index) => {
    statements.push(
      db.insert(invoiceLines).values({
        id: newId(),
        invoiceId: invoice.id,
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
      .update(invoices)
      .set({
        clientId: input.clientId !== undefined ? input.clientId : invoice.clientId,
        issuedOn,
        dueOn:
          input.dueOn ||
          dueDateFrom(issuedOn, client?.paymentTermsDays ?? setting.defaultPaymentTermsDays),
        currency,
        jurisdiction,
        gstTreatment: treatment,
        fxRateToResidence,
        subtotal: totals.subtotal,
        gstAmount: totals.gstAmount,
        total: totals.total,
        reference: input.reference ?? invoice.reference,
        notes: input.notes ?? invoice.notes,
        terms: input.terms ?? invoice.terms,
        status: invoice.status === 'draft' && input.finalise ? 'sent' : invoice.status,
        // A changed invoice must not keep a stale PDF around.
        pdfKey: null,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoice.id)),
  );

  statements.push(
    db.insert(activityLog).values({
      id: newId(),
      userId: invoice.userId,
      action: 'invoice.edited',
      entityType: 'invoice',
      entityId: invoice.id,
      detail: JSON.stringify({
        number: invoice.number,
        from: { total: invoice.total, gst: invoice.gstAmount },
        to: { total: totals.total, gst: totals.gstAmount },
      }),
      createdAt: now,
    }),
  );

  await db.batch(statements as never);
}

/**
 * Void, write off, or reverse either.
 *
 * Voiding says the invoice should never have existed; writing off says it was
 * owed and will not be paid. They are different things to a tax return — a
 * bad debt is deductible, a voided invoice is simply not income — so they are
 * separate states rather than one "cancelled".
 *
 * Neither deletes anything. The number stays used, which is the point: a gap
 * in an invoice sequence is the first thing an auditor asks about.
 */
export async function setInvoiceStatus(
  db: Db,
  invoice: Invoice,
  status: 'void' | 'written-off' | 'reinstate',
  note?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const next =
    status === 'reinstate'
      ? deriveStatus({ ...invoice, status: invoice.sentAt ? 'sent' : 'draft' })
      : status;

  await db.batch([
    db
      .update(invoices)
      .set({
        status: next,
        notes: note ? `${invoice.notes}${invoice.notes ? '\n\n' : ''}${note}`.slice(0, 5000) : invoice.notes,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoice.id)),
    db.insert(activityLog).values({
      id: newId(),
      userId: invoice.userId,
      action: `invoice.${status}`,
      entityType: 'invoice',
      entityId: invoice.id,
      detail: JSON.stringify({ number: invoice.number, from: invoice.status, to: next, note }),
      createdAt: now,
    }),
  ] as never);
}

/** Discard a draft outright. Only ever a draft — see `setInvoiceStatus`. */
export async function deleteDraftInvoice(db: Db, invoice: Invoice): Promise<void> {
  if (invoice.status !== 'draft') {
    throw new Error('Only a draft can be deleted. Void the invoice instead.');
  }
  const now = new Date().toISOString();
  await db.batch([
    // Release any time entries it had claimed, so they can be billed again.
    db
      .update(timeEntries)
      .set({ billed: false, invoiceId: null, updatedAt: now })
      .where(eq(timeEntries.invoiceId, invoice.id)),
    db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)),
    db.delete(invoices).where(eq(invoices.id, invoice.id)),
    db.insert(activityLog).values({
      id: newId(),
      userId: invoice.userId,
      action: 'invoice.draft-deleted',
      entityType: 'invoice',
      entityId: invoice.id,
      detail: JSON.stringify({ number: invoice.number, total: invoice.total }),
      createdAt: now,
    }),
  ] as never);
}

export interface RecordPaymentInput {
  userId: string;
  invoiceId: string;
  amount: Cents;
  receivedOn: string;
  method: 'bank-transfer' | 'stripe' | 'cash' | 'paypal' | 'wise' | 'other';
  fee?: Cents;
  reference?: string;
  stripeChargeId?: string;
  notes?: string;
}

/** A payment is denominated in the currency of the invoice it settles. */
interface PaymentCurrency {
  currency: 'NZD' | 'AUD';
  fxRateToResidence: number;
}

/**
 * Record a payment and roll the invoice forward.
 *
 * `amountPaid` is recomputed from the payments table rather than incremented,
 * so a duplicated webhook or a double-submitted form cannot drift the total.
 */
export async function recordPayment(db: Db, input: RecordPaymentInput): Promise<void> {
  const now = new Date().toISOString();

  // A Stripe charge id is unique per payment; if we already have it, the
  // webhook is a retry and there is nothing to do.
  if (input.stripeChargeId) {
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.stripeChargeId, input.stripeChargeId))
      .limit(1);
    if (existing[0]) return;
  }

  /**
   * Read the invoice FIRST, because the payment inherits its currency from
   * the invoice it settles. This used to write `currency: 'NZD'` as a
   * literal, so a paid AUD invoice produced a payment record that claimed to
   * be New Zealand dollars — and every figure built from the payments table
   * was wrong by the exchange rate.
   */
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) return;

  const denomination: PaymentCurrency = {
    currency: invoice.currency,
    fxRateToResidence: invoice.fxRateToResidence,
  };

  try {
    await db.insert(payments).values({
      id: newId(),
      userId: input.userId,
      invoiceId: input.invoiceId,
      amount: input.amount,
      currency: denomination.currency,
      fxRateToResidence: denomination.fxRateToResidence,
      receivedOn: input.receivedOn,
      method: input.method,
      fee: input.fee ?? 0,
      reference: input.reference ?? '',
      stripeChargeId: input.stripeChargeId ?? null,
      notes: input.notes ?? '',
      createdAt: now,
    });
  } catch (error) {
    /**
     * `payments_stripe_charge_idx` is unique, so a webhook that raced past
     * the check above lands here instead of double-crediting the invoice.
     * That is the constraint doing its job, not a failure — but only for
     * THAT constraint. Anything else is a real error and must not be
     * swallowed.
     */
    const isDuplicateCharge =
      Boolean(input.stripeChargeId) && /UNIQUE constraint failed/i.test(String(error));
    if (!isDuplicateCharge) throw error;
    return;
  }

  const totals = await db
    .select({ paid: sql<number>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(eq(payments.invoiceId, input.invoiceId));

  const amountPaid = totals[0]?.paid ?? 0;

  const status = deriveStatus({ ...invoice, amountPaid });

  await db
    .update(invoices)
    .set({
      amountPaid,
      status,
      paidOn: status === 'paid' ? input.receivedOn : null,
      updatedAt: now,
    })
    .where(eq(invoices.id, input.invoiceId));

  await db.insert(activityLog).values({
    id: newId(),
    userId: input.userId,
    action: 'payment.recorded',
    entityType: 'invoice',
    entityId: input.invoiceId,
    detail: JSON.stringify({ amount: input.amount, method: input.method }),
    createdAt: now,
  });
}

export interface InvoiceListFilters {
  status?: string;
  clientId?: string;
  search?: string;
  limit?: number;
}

export async function listInvoices(
  db: Db,
  userId: string,
  filters: InvoiceListFilters = {},
): Promise<Array<Invoice & { clientName: string | null }>> {
  const today = new Date().toISOString().slice(0, 10);

  const conditions = [eq(invoices.userId, userId)];
  if (filters.clientId) conditions.push(eq(invoices.clientId, filters.clientId));

  if (filters.status === 'unpaid') {
    conditions.push(sql`${invoices.status} in ('sent', 'viewed', 'partial', 'overdue')`);
  } else if (filters.status === 'overdue') {
    conditions.push(sql`${invoices.status} in ('sent', 'viewed', 'partial', 'overdue')`);
    conditions.push(sql`${invoices.dueOn} < ${today}`);
  } else if (filters.status && filters.status !== 'all') {
    conditions.push(eq(invoices.status, filters.status as Invoice['status']));
  }

  const rows = await db
    .select({ invoice: invoices, clientName: clients.name })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(and(...conditions))
    .orderBy(desc(invoices.issuedOn), desc(invoices.number))
    .limit(filters.limit ?? 200);

  // Recompute status on read so "overdue" is always current without a cron.
  return rows.map((row) => ({
    ...row.invoice,
    status: deriveStatus(row.invoice, today),
    clientName: row.clientName,
  }));
}
