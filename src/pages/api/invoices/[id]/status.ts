import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { getInvoice, setInvoiceStatus, deleteDraftInvoice } from '~/lib/invoices/service';

export const prerender = false;

const ACTIONS = new Set(['void', 'written-off', 'reinstate', 'delete-draft']);

/**
 * Void an invoice, write it off as a bad debt, reverse either, or discard a
 * draft.
 *
 * Nothing here deletes an issued invoice. A gap in an invoice sequence is the
 * first thing anyone auditing the books asks about, so a document that has
 * been given to someone keeps its number for good and changes state instead.
 * A draft was never issued, so it can simply go.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  if (!ACTIONS.has(action)) {
    return redirect(`/invoices/${invoice.id}?error=${encodeURIComponent('Unknown action.')}`, 302);
  }

  const note = String(form.get('note') ?? '').trim().slice(0, 500);

  if (action === 'delete-draft') {
    if (invoice.status !== 'draft') {
      return redirect(
        `/invoices/${invoice.id}?error=${encodeURIComponent(
          'Only a draft can be deleted. Void it instead, so the number stays accounted for.',
        )}`,
        302,
      );
    }
    await deleteDraftInvoice(database, invoice);
    return redirect('/invoices?deleted=1', 302);
  }

  if (action !== 'reinstate' && invoice.amountPaid > 0) {
    return redirect(
      `/invoices/${invoice.id}?error=${encodeURIComponent(
        'This invoice has payments recorded against it. Reverse or remove those first, or raise a credit note.',
      )}`,
      302,
    );
  }

  await setInvoiceStatus(database, invoice, action as 'void' | 'written-off' | 'reinstate', note);
  return redirect(`/invoices/${invoice.id}?status=${action}`, 302);
};
