import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { appUrl, bindings, db } from '~/lib/env';
import { demoSites, proposals, prospects } from '~/lib/db/schema';
import { getSettings } from '~/lib/queries/settings';
import { sendOutreach } from '~/lib/growth/proposal';
import { countSentToday } from '~/lib/growth/engine';

export const prerender = false;

/**
 * Send an outreach email by hand.
 *
 * The daily cap does not apply here: it exists to bound what runs unattended,
 * not to stop a person sending an email they are looking at. The count is
 * still shown back so the cap is not silently exhausted by hand-sent mail.
 */
export const POST: APIRoute = async ({ request, params, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const id = String(params.id ?? '');
  const database = db();

  const rows = await database
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, id), eq(proposals.userId, user.id)))
    .limit(1);

  const proposal = rows[0];
  if (!proposal) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const back = `/growth/proposals/${id}`;

  // Edits made in the review screen are what gets sent.
  const subject = String(form.get('subject') ?? proposal.emailSubject).trim().slice(0, 160);
  const body = String(form.get('body') ?? proposal.emailBody).trim().slice(0, 6000);
  const to = String(form.get('to') ?? proposal.sentTo).trim().toLowerCase().slice(0, 320);

  const now = new Date().toISOString();
  await database
    .update(proposals)
    .set({ emailSubject: subject, emailBody: body, sentTo: to, updatedAt: now })
    .where(eq(proposals.id, id));

  if (form.get('action') === 'save') return redirect(`${back}?saved=1`, 302);

  if (proposal.status === 'sent' && form.get('confirmResend') !== 'yes') {
    return redirect(`${back}?error=${encodeURIComponent('This has already been sent. Tick the box to send it again.')}`, 302);
  }

  const settings = await getSettings(database, user.id);
  const demo = proposal.demoSiteId
    ? (await database.select().from(demoSites).where(eq(demoSites.id, proposal.demoSiteId)).limit(1))[0]
    : undefined;
  const prospect = proposal.prospectId
    ? (await database.select().from(prospects).where(eq(prospects.id, proposal.prospectId)).limit(1))[0]
    : undefined;

  const outcome = await sendOutreach(
    bindings(),
    {
      to,
      toName: prospect?.contactName || prospect?.businessName || '',
      subject,
      body,
      demoUrl: demo ? `https://${demo.host}` : '',
      proposalUrl: `${appUrl()}/proposal/${proposal.publicToken}`,
      senderName: settings.outreachSenderName || settings.businessName || 'JWBS Studio',
      signature: settings.outreachSignature,
      replyTo: settings.outreachReplyTo || settings.email,
    },
    { sentToday: 0, dailyCap: 0, initiatedByUser: true },
  );

  if (!outcome.ok) {
    await database
      .update(proposals)
      .set({ sendResult: outcome.error.slice(0, 500), updatedAt: now })
      .where(eq(proposals.id, id));
    return redirect(`${back}?error=${encodeURIComponent(outcome.error)}`, 302);
  }

  await database
    .update(proposals)
    .set({
      status: 'sent',
      sentAt: now,
      sendResult: `${outcome.result.provider}:${outcome.result.id ?? 'ok'}`,
      updatedAt: now,
    })
    .where(eq(proposals.id, id));

  if (prospect) {
    await database
      .update(prospects)
      .set({ status: 'contacted', updatedAt: now })
      .where(eq(prospects.id, prospect.id));
  }

  const sentToday = await countSentToday(database, user.id);
  const remaining = Math.max(0, settings.outreachDailyCap - sentToday);
  return redirect(`${back}?sent=1&remaining=${remaining}`, 302);
};
