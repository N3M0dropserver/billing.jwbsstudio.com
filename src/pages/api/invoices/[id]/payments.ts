import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getInvoice, recordPayment } from '~/lib/invoices/service';
import { parseAmount } from '~/lib/tax/money';

export const prerender = false;

const METHODS = new Set(['bank-transfer', 'stripe', 'cash', 'paypal', 'wise', 'other']);

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const form = await request.formData();
  const rawAmount = String(form.get('amount') ?? '');
  // An empty amount means "paid in full", which is the common case.
  const amount = rawAmount.trim()
    ? parseAmount(rawAmount)
    : invoice.total - invoice.amountPaid;

  if (amount <= 0) {
    return redirect(`/invoices/${invoice.id}?payment=invalid`, 302);
  }

  const method = String(form.get('method') ?? 'bank-transfer');

  await recordPayment(database, {
    userId: user.id,
    invoiceId: invoice.id,
    amount,
    receivedOn: String(form.get('receivedOn') ?? new Date().toISOString().slice(0, 10)),
    method: (METHODS.has(method) ? method : 'other') as 'bank-transfer',
    fee: parseAmount(String(form.get('fee') ?? '0')),
    reference: String(form.get('reference') ?? ''),
    notes: String(form.get('notes') ?? ''),
  });

  return redirect(`/invoices/${invoice.id}?payment=ok`, 302);
};
