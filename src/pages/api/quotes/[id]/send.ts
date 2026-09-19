import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, files, appUrl, bindings } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { getQuote } from '~/lib/quotes/service';
import { quoteToPdfData } from '~/lib/quotes/pdf-data';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { brandingFor } from '~/lib/invoices/branding';
import { sendMail } from '~/lib/mail';
import { quoteEmail } from '~/lib/mail/templates';
import { proposals, communications, activityLog } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const quote = await getQuote(database, user.id, params.id!);
  if (!quote) return new Response('Quote not found', { status: 404 });

  const form = await request.formData();
  const recipient = String(form.get('to') ?? quote.client?.email ?? '').trim();
  if (!recipient) return redirect(`/quotes/${quote.id}?sent=no-email`, 302);

  const settings = await getSettings(database, user.id);
  const env = bindings();
  const viewUrl = quote.publicToken ? `${appUrl()}/proposal/${quote.publicToken}` : appUrl();
  const branding = await brandingFor(database, files(), user.id, null);
  const pdf = renderInvoicePdf(quoteToPdfData(quote, settings, { viewUrl }), branding);

  const content = quoteEmail({
    quoteNumber: quote.number,
    title: quote.title,
    clientName: quote.client?.name ?? 'there',
    businessName: settings.businessName || 'Your business',
    senderName: user.name,
    total: quote.total,
    currency: quote.currency,
    expiresOn: quote.expiresOn,
    viewUrl,
    customMessage: String(form.get('message') ?? '') || undefined,
  });

  const result = await sendMail(env, {
    to: recipient,
    toName: quote.client?.name,
    subject: content.subject,
    text: content.text,
    html: content.html,
    replyTo: settings.email || undefined,
    attachments: [
      { filename: `${quote.number}.pdf`, content: pdf, contentType: 'application/pdf' },
    ],
  });

  if (!result.ok) {
    return redirect(
      `/quotes/${quote.id}?sent=failed&reason=${encodeURIComponent(result.error ?? 'unknown')}`,
      302,
    );
  }

  const now = new Date().toISOString();
  await database
    .update(proposals)
    .set({
      status: quote.status === 'draft' ? 'sent' : quote.status,
      sentAt: quote.sentAt ?? now,
      updatedAt: now,
    })
    .where(eq(proposals.id, quote.id));

  if (quote.clientId) {
    await database.insert(communications).values({
      id: newId(),
      userId: user.id,
      clientId: quote.clientId,
      kind: 'email',
      subject: content.subject,
      body: 'Quote sent.',
      occurredAt: now,
      createdAt: now,
    });
  }

  await database.insert(activityLog).values({
    id: newId(),
    userId: user.id,
    action: 'quote.sent',
    entityType: 'proposal',
    entityId: quote.id,
    detail: JSON.stringify({ to: recipient, number: quote.number }),
    createdAt: now,
  });

  return redirect(`/quotes/${quote.id}?sent=ok`, 302);
};
