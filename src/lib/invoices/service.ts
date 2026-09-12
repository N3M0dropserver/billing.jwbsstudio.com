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
import { createdEventStatement, recordInvoiceEvent } from '~/lib/activity/events';
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
}

export async function createInvoice(
  db: Db,
  setting: Settings,
  input: CreateInvoiceInput,
): Promise<{ id: string; number: string }> {
  const client = input.clientId
    ? (await db.select().from(clients).where(eq(clients.id, input.clientId)).limit(1))[0] ?? null
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
    createdEventStatement(db, {
      invoiceId,
      clientId: input.clientId,
      userId: input.userId,
      type: 'created',
      actor: 'user',
      detail: { number, total: totals.total, currency: input.currency },
      occurredAt: now,
    }),
  );

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

export async function updateInvoiceLines(
  db: Db,
  setting: Settings,
  invoice: Invoice,
  lines: Array<LineInput & { unit?: string }>,
): Promise<void> {
  const taxYear =
    invoice.jurisdiction === 'NZ'
      ? nzTaxYearFor(new Date(`${invoice.issuedOn}T00:00:00Z`))
      : auFinancialYearFor(new Date(`${invoice.issuedOn}T00:00:00Z`));

  const totals = calculateInvoice(lines, {
    jurisdiction: invoice.jurisdiction,
    year: taxYear,
    treatment: invoice.gstTreatment,
  });

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
        unit: lines[index]?.unit ?? 'hours',
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
        subtotal: totals.subtotal,
        gstAmount: totals.gstAmount,
        total: totals.total,
        // A changed invoice must not keep a stale PDF around.
        pdfKey: null,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoice.id)),
  );

  await db.batch(statements as never);
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

  await db.insert(payments).values({
    id: newId(),
    userId: input.userId,
    invoiceId: input.invoiceId,
    amount: input.amount,
    currency: 'NZD',
    receivedOn: input.receivedOn,
    method: input.method,
    fee: input.fee ?? 0,
    reference: input.reference ?? '',
    stripeChargeId: input.stripeChargeId ?? null,
    notes: input.notes ?? '',
    createdAt: now,
  });

  const totals = await db
    .select({ paid: sql<number>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(eq(payments.invoiceId, input.invoiceId));

  const amountPaid = totals[0]?.paid ?? 0;

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) return;

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

  // A Stripe payment arrives on a webhook with nobody signed in, so the actor
  // is the system rather than the user who happens to own the invoice.
  const actor = input.method === 'stripe' ? 'system' : 'user';

  await recordInvoiceEvent(db, {
    invoiceId: input.invoiceId,
    clientId: invoice.clientId,
    userId: input.userId,
    type: 'payment-recorded',
    actor,
    detail: {
      amount: input.amount,
      currency: invoice.currency,
      method: input.method,
      reference: input.reference ?? '',
    },
    occurredAt: now,
  });

  if (status === 'paid') {
    await recordInvoiceEvent(db, {
      invoiceId: input.invoiceId,
      clientId: invoice.clientId,
      userId: input.userId,
      type: 'paid',
      actor: 'system',
      detail: { total: invoice.total, currency: invoice.currency },
      occurredAt: now,
    });
  }
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
