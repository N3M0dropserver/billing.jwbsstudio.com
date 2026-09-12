import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, files, appUrl, bindings } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getInvoice } from '~/lib/invoices/service';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { sendMail } from '~/lib/mail';
import { invoiceEmail, reminderEmail } from '~/lib/mail/templates';
import { renderTemplate } from '~/lib/mail/render';
import { invoiceValues } from '~/lib/mail/variables';
import { pixelUrl, withTrackingPixel } from '~/lib/mail/tracking';
import { getTemplate, defaultTemplate } from '~/lib/queries/templates';
import { startSend, completeSend, recordFailure } from '~/lib/queries/sends';
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

  /**
   * Which wording to use.
   *
   * An explicit `templateId` wins; otherwise the default template for this
   * kind, if one is set; otherwise the built-in wording. That last branch is
   * what runs for an account with no templates at all, so sending keeps
   * working exactly as it did before templates existed.
   */
  const kind = isReminder ? 'reminder' : 'invoice';
  const requestedTemplateId = String(form.get('templateId') ?? '').trim();

  let template = null;
  if (requestedTemplateId === 'none') {
    template = null;
  } else if (requestedTemplateId) {
    template = await getTemplate(database, user.id, requestedTemplateId);
  } else {
    template = await defaultTemplate(database, user.id, kind);
  }

  // An empty template would send a blank email. Fall back rather than do that.
  if (template && !template.html.trim()) template = null;

  let content: { subject: string; text: string; html: string };

  if (template) {
    const values = {
      ...invoiceValues({
        invoiceNumber: invoice.number,
        clientName: invoice.client?.name ?? 'there',
        clientEmail: invoice.client?.email ?? recipient,
        total: invoice.total,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency,
        issuedOn: invoice.issuedOn,
        dueOn: invoice.dueOn,
        reference: invoice.reference,
        daysOverdue,
        viewUrl: payUrl ?? appUrl(),
        payUrl: settings.stripeEnabled ? payUrl : undefined,
        businessName: settings.businessName || 'Your business',
        businessEmail: settings.email,
        businessPhone: settings.phone,
        businessWebsite: settings.website,
        senderName: user.name,
      }),
      // The per-send note from the send form, available to templates that
      // want to place it rather than having it forced into a fixed slot.
      'message': customMessage,
    };

    content = {
      // Subject and text are not HTML; escaping them would show `&amp;`.
      subject: renderTemplate(template.subject, values, { escape: false }),
      text: renderTemplate(template.text, values, { escape: false }),
      html: renderTemplate(template.html, values),
    };
  } else {
    content = isReminder
      ? reminderEmail({ ...emailData, daysOverdue: Math.max(daysOverdue, 0) })
      : invoiceEmail(emailData);
  }

  /**
   * Recorded before sending, because the tracking token has to exist in order
   * to be embedded in the body. A row whose `provider` stays empty is a send
   * that was attempted and failed — worth keeping when a client says the email
   * never arrived.
   */
  const send = await startSend(database, {
    userId: user.id,
    entityType: 'invoice',
    entityId: invoice.id,
    templateId: template?.id ?? null,
    toAddress: recipient,
    subject: content.subject,
  });

  const result = await sendMail(env, {
    to: recipient,
    toName: invoice.client?.name,
    subject: content.subject,
    text: content.text,
    html: withTrackingPixel(content.html, pixelUrl(appUrl(), send.token)),
    replyTo: settings.email || undefined,
    attachments: [
      { filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' },
    ],
  });

  if (!result.ok) {
    await recordFailure(database, send.id, result.error ?? 'unknown');
    return redirect(
      `/invoices/${invoice.id}?sent=failed&reason=${encodeURIComponent(result.error ?? 'unknown')}`,
      302,
    );
  }

  await completeSend(database, send.id, result.provider, result.id);

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
