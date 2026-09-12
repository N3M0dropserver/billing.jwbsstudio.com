import type { APIRoute } from 'astro';
import { db, bindings, appUrl } from '~/lib/env';
import { findUserByEmail } from '~/lib/auth/session';
import { issueMagicLink, magicLinkUrl, LINK_TTL_MINUTES } from '~/lib/auth/magic-link';
import { safeNext } from '~/lib/auth/redirect';
import { recordAuth, logAuth } from '~/lib/auth/log';
import { sendMail } from '~/lib/mail';
import { magicLinkEmail } from '~/lib/mail/templates';

export const prerender = false;

const ACTION = 'auth.magic-link.request';

export const POST: APIRoute = async ({ request, redirect, clientAddress }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const next = safeNext(form.get('next'));
  const ip = clientAddress ?? null;
  const userAgent = request.headers.get('user-agent');

  /**
   * One answer for every outcome. Whether the address is on the system, is
   * disabled, or has asked five times in a row is not something the login
   * page should confirm to whoever typed it — the log below says which it
   * was, and the log is only visible to us.
   */
  const sent = () => redirect(`/login?sent=1&next=${encodeURIComponent(next)}`, 302);

  if (!email) {
    logAuth({ action: ACTION, outcome: 'denied', reason: 'missing-fields', ip });
    return redirect(`/login?error=missing-fields&next=${encodeURIComponent(next)}`, 302);
  }

  const database = db();
  const user = await findUserByEmail(database, email);

  if (!user) {
    await recordAuth(database, { action: ACTION, outcome: 'denied', reason: 'unknown-email', email, ip, userAgent });
    return sent();
  }

  if (user.disabledAt) {
    await recordAuth(database, {
      action: ACTION,
      outcome: 'denied',
      reason: 'account-disabled',
      userId: user.id,
      email,
      ip,
      userAgent,
    });
    return sent();
  }

  // A locked account is deliberately still allowed a link. The lockout exists
  // to stop password guessing; possession of the mailbox is a stronger claim
  // than the password it is protecting, and this is the way back in.
  const issued = await issueMagicLink(database, user, { ip, userAgent });

  if (!issued.ok) {
    await recordAuth(database, {
      action: ACTION,
      outcome: 'denied',
      reason: issued.reason,
      userId: user.id,
      email,
      ip,
      userAgent,
      extra: { activeLinks: issued.activeCount },
    });
    return sent();
  }

  const env = bindings();
  const url = magicLinkUrl(appUrl(), issued.token, next);
  const mail = magicLinkEmail({
    name: user.name || user.email,
    appName: env.APP_NAME || 'JWBS Studio Billing',
    url,
    expiresMinutes: LINK_TTL_MINUTES,
    requestedIp: ip,
  });

  const result = await sendMail(env, {
    to: user.email,
    toName: user.name,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });

  if (!result.ok) {
    await recordAuth(database, {
      action: ACTION,
      outcome: 'error',
      reason: env.MAIL_PROVIDER === 'none' ? 'mail-disabled' : 'mail-failed',
      userId: user.id,
      email,
      ip,
      userAgent,
      tokenFingerprint: issued.tokenFingerprint,
      detail: result.error,
      extra: { provider: result.provider },
    });
  } else {
    await recordAuth(database, {
      action: ACTION,
      outcome: 'ok',
      userId: user.id,
      email,
      ip,
      userAgent,
      tokenFingerprint: issued.tokenFingerprint,
      extra: { provider: result.provider, messageId: result.id, expiresAt: issued.expiresAt.toISOString() },
    });
  }

  /**
   * The escape hatch for local development, where there is usually no
   * deliverable mail path at all. Off unless AUTH_DEBUG is set, because the
   * printed URL is a working credential for as long as it lives and does not
   * belong in production logs.
   */
  if (env.AUTH_DEBUG === '1') {
    logAuth({
      action: 'auth.magic-link.debug',
      outcome: 'ok',
      userId: user.id,
      email,
      detail: `AUTH_DEBUG is on, so here is the link instead of only the email: ${url}`,
    });
  }

  // Mail failures are not surfaced to the page either — same reasoning. The
  // log line above names the provider error, which is where you fix it.
  return sent();
};
