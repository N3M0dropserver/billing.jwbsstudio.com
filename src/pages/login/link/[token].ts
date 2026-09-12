import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { consumeMagicLink } from '~/lib/auth/magic-link';
import { createSession, recordSuccessfulLogin, setSessionCookie } from '~/lib/auth/session';
import { safeNext } from '~/lib/auth/redirect';
import { recordAuth } from '~/lib/auth/log';

export const prerender = false;

const ACTION = 'auth.magic-link.redeem';

export const GET: APIRoute = async ({ params, request, url, cookies, redirect, clientAddress }) => {
  const token = params.token ?? '';
  const next = safeNext(url.searchParams.get('next'));
  const ip = clientAddress ?? null;
  const userAgent = request.headers.get('user-agent');

  if (!token) return redirect('/login?error=link-unknown', 302);

  const database = db();
  const result = await consumeMagicLink(database, token);

  if (!result.ok) {
    await recordAuth(database, {
      action: ACTION,
      outcome: 'denied',
      reason: result.reason,
      userId: result.userId ?? null,
      ip,
      userAgent,
      tokenFingerprint: result.tokenFingerprint,
      path: url.pathname,
    });
    return redirect(`/login?error=${result.reason}`, 302);
  }

  const user = result.user;

  // Redeeming a link clears the lockout as well as the attempt counter: the
  // point of allowing a locked account to request one is that it gets you
  // back in, which it would not if the lock survived the sign-in.
  await recordSuccessfulLogin(database, user);

  const session = await createSession(database, user.id, { userAgent, ipAddress: ip });
  setSessionCookie(cookies, url, session.token, session.expiresAt);

  await recordAuth(database, {
    action: ACTION,
    outcome: 'ok',
    userId: user.id,
    email: user.email,
    ip,
    userAgent,
    tokenFingerprint: result.tokenFingerprint,
    extra: { next, mustChangePassword: user.mustChangePassword },
  });

  return redirect(user.mustChangePassword ? '/account/password' : next, 302);
};
