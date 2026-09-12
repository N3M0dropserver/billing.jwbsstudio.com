import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, files, appUrl, bindings } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getInvoice } from '~/lib/invoices/service';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { sendMail } from '~/lib/mail';
import { invoiceEmail, reminderEmail } from '~/lib/mail/templates';
import { invoices, communications, activityLog } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const invoice = await getInvoice(database, user.id, params.id!);
  if (!invoice) return new Response('Invoice not found', { status: 404 });

  const form = await request.formData();
  const isReminder = form.get('kind') === 'reminder';
  const customMessage = String(form.get('message') ?? '');
  const recipient = String(form.get('to') ?? invoice.client?.email ?? '').trim();

  if (!recipient) return redirect(`/invoices/${invoice.id}?sent=no-email`, 302);

  const settings = await getSettings(database, user.id);
  const env = bindings();
  const payUrl = invoice.publicToken ? `${appUrl()}/pay/${invoice.publicToken}` : undefined;
  const pdf = renderInvoicePdf(toPdfData(invoice, settings, { payUrl }));

  const daysOverdue = Math.floor(
    (Date.now() - new Date(`${invoice.dueOn}T00:00:00Z`).getTime()) / 86_400_000,
  );

  const emailData = {
    invoiceNumber: invoice.number,
    clientName: invoice.client?.name ?? 'there',
    businessName: settings.businessName || 'Your business',
    senderName: user.name,
    total: invoice.total - invoice.amountPaid,
    currency: invoice.currency,
    dueOn: invoice.dueOn,
    viewUrl: payUrl ?? appUrl(),
    payUrl: settings.stripeEnabled ? payUrl : undefined,
    customMessage: customMessage || undefined,
  };

  const content = isReminder
    ? reminderEmail({ ...emailData, daysOverdue: Math.max(daysOverdue, 0) })
    : invoiceEmail(emailData);

  const result = await sendMail(env, {
    to: recipient,
    toName: invoice.client?.name,
    subject: content.subject,
    text: content.text,
    html: content.html,
    replyTo: settings.email || undefined,
    attachments: [
      { filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' },
    ],
  });

  if (!result.ok) {
    return redirect(
      `/invoices/${invoice.id}?sent=failed&reason=${encodeURIComponent(result.error ?? 'unknown')}`,
      302,
    );
  }

  const now = new Date().toISOString();

  // Keep the exact bytes that were emailed, so a dispute can be settled by
  // producing the document the client actually received.
  try {
    const key = `invoices/${user.id}/${invoice.number}.pdf`;
    await files().put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
    await database.update(invoices).set({ pdfKey: key }).where(eq(invoices.id, invoice.id));
  } catch {
    // Non-fatal: the email has already gone.
  }

  await database
    .update(invoices)
    .set({
      status: invoice.status === 'draft' ? 'sent' : invoice.status,
      sentAt: invoice.sentAt ?? now,
      remindersSent: isReminder ? invoice.remindersSent + 1 : invoice.remindersSent,
      lastReminderAt: isReminder ? now : invoice.lastReminderAt,
      updatedAt: now,
    })
    .where(eq(invoices.id, invoice.id));

  if (invoice.clientId) {
    await database.insert(communications).values({
      id: newId(),
      userId: user.id,
      clientId: invoice.clientId,
      kind: 'invoice-sent',
      subject: content.subject,
      body: isReminder ? 'Payment reminder sent.' : 'Invoice sent.',
      occurredAt: now,
      createdAt: now,
    });
  }

  await database.insert(activityLog).values({
    id: newId(),
    userId: user.id,
    action: isReminder ? 'invoice.reminder_sent' : 'invoice.sent',
    entityType: 'invoice',
    entityId: invoice.id,
    detail: JSON.stringify({ to: recipient, provider: result.provider }),
    createdAt: now,
  });

  return redirect(`/invoices/${invoice.id}?sent=ok`, 302);
};
