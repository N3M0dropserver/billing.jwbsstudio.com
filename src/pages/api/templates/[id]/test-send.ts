import type { APIRoute } from 'astro';
import { db, bindings, appUrl } from '~/lib/env';
import { getTemplate } from '~/lib/queries/templates';
import { getSettings } from '~/lib/queries/settings';
import { startSend, completeSend, recordFailure } from '~/lib/queries/sends';
import { sendMail } from '~/lib/mail';
import { renderTemplate } from '~/lib/mail/render';
import { sampleValues, type TemplateKind } from '~/lib/mail/variables';
import { pixelUrl, withTrackingPixel } from '~/lib/mail/tracking';

export const prerender = false;

/**
 * Send the template to yourself.
 *
 * Goes through the real provider and the real tracking pixel rather than a
 * simulation — the failures worth catching here are the ones a preview cannot
 * show you: a mail client mangling the layout, images not loading from R2, or
 * the sending domain not being onboarded yet.
 *
 * Sample values fill the record-specific variables, but your real business
 * details are used where they exist, so the signature and contact lines look
 * the way they actually will.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const database = db();
  const template = await getTemplate(database, user.id, params.id!);
  if (!template) return new Response('Template not found', { status: 404 });

  if (!template.html.trim()) {
    return Response.json({ ok: false, error: 'Nothing to send — the template is empty.' }, { status: 400 });
  }

  const settings = await getSettings(database, user.id);
  const values = {
    ...sampleValues(template.kind as TemplateKind),
    'business.name': settings.businessName || 'Your business',
    'business.email': settings.email,
    'business.phone': settings.phone,
    'business.website': settings.website,
    'sender.name': user.name,
  };

  const subject = `[Test] ${renderTemplate(template.subject, values, { escape: false })}`;

  const send = await startSend(database, {
    userId: user.id,
    entityType: 'test',
    entityId: template.id,
    templateId: template.id,
    toAddress: user.email,
    subject,
  });

  const html = withTrackingPixel(
    renderTemplate(template.html, values),
    pixelUrl(appUrl(), send.token),
  );

  const result = await sendMail(bindings(), {
    to: user.email,
    toName: user.name,
    subject,
    text: renderTemplate(template.text, values, { escape: false }),
    html,
    replyTo: settings.email || undefined,
  });

  if (!result.ok) {
    await recordFailure(database, send.id, result.error ?? 'unknown');
    return Response.json({ ok: false, error: result.error }, { status: 502 });
  }

  await completeSend(database, send.id, result.provider, result.id);
  return Response.json({ ok: true, to: user.email });
};
