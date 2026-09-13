import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { bankTransactions, payments } from '~/lib/db/schema';
import { getInvoice, recordPayment } from '~/lib/invoices/service';

export const prerender = false;

/**
 * Confirm or dismiss a proposed match.
 *
 * The matcher proposes; this is where a person decides. Confirming records a
 * real payment against the invoice through the ordinary path — the same one
 * the manual form and the Stripe webhook use — so the invoice status, the
 * paid total and the activity log all behave exactly as they always have.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const transactionId = String(form.get('transactionId') ?? '');

  const database = db();
  const rows = await database
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, transactionId), eq(bankTransactions.userId, user.id)))
    .limit(1);

  const transaction = rows[0];
  if (!transaction) return new Response('Transaction not found', { status: 404 });

  const back = (query: string) => redirect(`/bank?${query}`, 302);

  if (action === 'ignore') {
    await database
      .update(bankTransactions)
      .set({ status: 'ignored', updatedAt: new Date().toISOString() })
      .where(eq(bankTransactions.id, transaction.id));
    return back('ignored=1');
  }

  if (action === 'unmatch') {
    /**
     * Undo, without deleting the payment. Removing money from an invoice
     * because somebody clicked the wrong row is a bigger action than this
     * button implies — the link is broken and the payment is left for you to
     * remove deliberately from the invoice itself.
     */
    await database
      .update(bankTransactions)
      .set({
        status: 'unmatched',
        matchedInvoiceId: null,
        matchedPaymentId: null,
        matchReason: '',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bankTransactions.id, transaction.id));
    return back('unmatched=1');
  }

  if (action !== 'confirm') {
    return back('error=' + encodeURIComponent('Unknown action.'));
  }

  if (transaction.status === 'matched') {
    return back('error=' + encodeURIComponent('That transaction is already matched.'));
  }
  if (transaction.amount <= 0) {
    return back('error=' + encodeURIComponent('Only money coming in can settle an invoice.'));
  }

  const invoiceId = String(form.get('invoiceId') ?? '');
  const invoice = await getInvoice(database, user.id, invoiceId);
  if (!invoice) return back('error=' + encodeURIComponent('That invoice no longer exists.'));

  const outstanding = invoice.total - invoice.amountPaid;
  if (outstanding <= 0) {
    return back('error=' + encodeURIComponent(`${invoice.number} is already settled.`));
  }
  if (transaction.amount > outstanding) {
    return back(
      'error=' +
        encodeURIComponent(
          `That credit is more than the ${invoice.number} balance. Record it by hand so the difference is deliberate.`,
        ),
    );
  }
  if (transaction.currency !== invoice.currency) {
    return back(
      'error=' +
        encodeURIComponent(
          `The statement is in ${transaction.currency} and ${invoice.number} is in ${invoice.currency}.`,
        ),
    );
  }

  await recordPayment(database, {
    userId: user.id,
    invoiceId: invoice.id,
    amount: transaction.amount,
    receivedOn: transaction.occurredOn,
    method: 'bank-transfer',
    reference: transaction.reference || transaction.description.slice(0, 100),
    notes: `Reconciled from a bank statement: ${transaction.description}`.slice(0, 500),
  });

  // Link the statement row to the payment it produced, so the trail runs both
  // ways: from the invoice to the bank line, and back.
  const created = await database
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoice.id), eq(payments.userId, user.id)))
    .orderBy(payments.createdAt);

  await database
    .update(bankTransactions)
    .set({
      status: 'matched',
      matchedInvoiceId: invoice.id,
      matchedPaymentId: created[created.length - 1]?.id ?? null,
      matchReason: String(form.get('reason') ?? '').slice(0, 300),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(bankTransactions.id, transaction.id));

  return back(`matched=${encodeURIComponent(invoice.number)}`);
};
