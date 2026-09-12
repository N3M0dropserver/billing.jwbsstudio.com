import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { verifyPassword, needsRehash, hashPassword } from '~/lib/auth/password';
import {
  createSession,
  findUserByEmail,
  isLockedOut,
  recordFailedAttempt,
  recordSuccessfulLogin,
  setSessionCookie,
} from '~/lib/auth/session';
import { safeNext } from '~/lib/auth/redirect';
import { recordAuth, logAuth } from '~/lib/auth/log';
import { users } from '~/lib/db/schema';
import { eq } from 'drizzle-orm';

export const prerender = false;

const ACTION = 'auth.login';

export const POST: APIRoute = async ({ request, url, cookies, redirect, clientAddress }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const next = safeNext(form.get('next'));
  const ip = clientAddress ?? null;
  const userAgent = request.headers.get('user-agent');

  /**
   * The page shows one of three vague messages; the log line carries the
   * real reason. Deliberate: the person at the keyboard may be the account
   * holder or may not, and only one of them gets to read the logs.
   */
  const fail = (shown: 'invalid' | 'disabled' | 'locked') =>
    redirect(`/login?error=${shown}&next=${encodeURIComponent(next)}`, 302);

  if (!email || !password) {
    logAuth({ action: ACTION, outcome: 'denied', reason: 'missing-fields', email: email || null, ip });
    return fail('invalid');
  }

  const database = db();
  const user = await findUserByEmail(database, email);

  if (!user) {
    // Burn comparable time on an unknown email so the response time does not
    // reveal whether the account exists.
    await verifyPassword(password, 'pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await recordAuth(database, { action: ACTION, outcome: 'denied', reason: 'unknown-email', email, ip, userAgent });
    return fail('invalid');
  }

  if (user.disabledAt) {
    await recordAuth(database, {
      action: ACTION, outcome: 'denied', reason: 'account-disabled',
      userId: user.id, email, ip, userAgent,
    });
    return fail('disabled');
  }

  if (isLockedOut(user)) {
    await recordAuth(database, {
      action: ACTION, outcome: 'denied', reason: 'account-locked',
      userId: user.id, email, ip, userAgent,
      extra: { lockedUntil: user.lockedUntil, failedAttempts: user.failedAttempts },
    });
    return fail('locked');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordFailedAttempt(database, user);
    await recordAuth(database, {
      action: ACTION, outcome: 'denied', reason: 'bad-password',
      userId: user.id, email, ip, userAgent,
      // The attempt count is the useful part here: a stored hash that no
      // longer matches anything looks the same as a typo until you see the
      // counter climb on every try.
      extra: { failedAttempts: user.failedAttempts + 1, hashScheme: user.passwordHash.split('$')[0] },
    });
    return fail('invalid');
  }

  // Opportunistically upgrade the hash if the work factor has since risen.
  if (needsRehash(user.passwordHash)) {
    await database
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
  }

  await recordSuccessfulLogin(database, user);

  const session = await createSession(database, user.id, { userAgent, ipAddress: ip });
  setSessionCookie(cookies, url, session.token, session.expiresAt);

  await recordAuth(database, {
    action: ACTION,
    outcome: 'ok',
    userId: user.id,
    email,
    ip,
    userAgent,
    // If a sign-in logs `ok` here and the very next request logs `no-cookie`,
    // the browser rejected the cookie rather than the credentials failing.
    // Recording which name was issued is what makes that diagnosable.
    extra: { next, secureCookie: url.protocol === 'https:', mustChangePassword: user.mustChangePassword },
  });

  return redirect(user.mustChangePassword ? '/account/password' : next, 302);
};
