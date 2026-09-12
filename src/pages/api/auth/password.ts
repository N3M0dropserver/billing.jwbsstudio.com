import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { hashPassword, verifyPassword, checkPasswordStrength } from '~/lib/auth/password';
import { destroyAllSessionsFor, createSession, setSessionCookie } from '~/lib/auth/session';
import { recordAuth } from '~/lib/auth/log';
import { users } from '~/lib/db/schema';

export const prerender = false;

export const POST: APIRoute = async ({ request, url, locals, cookies, redirect, clientAddress }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const current = String(form.get('current') ?? '');
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  const fail = async (reason: string, message: string) => {
    await recordAuth(db(), {
      action: 'auth.password.change-refused',
      outcome: 'denied',
      userId: user.id,
      email: user.email,
      ip: clientAddress ?? null,
      detail: reason,
    });
    return redirect(`/account/password?error=${encodeURIComponent(message)}`, 302);
  };

  if (password !== confirm) return fail('mismatch', 'The two new passwords do not match.');

  const strength = checkPasswordStrength(password);
  if (!strength.ok) return fail('weak', strength.problems.join(' '));

  // Only skip the current-password check on a forced first-time change.
  if (!user.mustChangePassword) {
    const ok = await verifyPassword(current, user.passwordHash);
    if (!ok) return fail('bad-current-password', 'Your current password was not correct.');
  }

  const database = db();
  await database
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, user.id));

  // A password change invalidates every session, including this one — then
  // we immediately issue a fresh one so the user is not bounced to login.
  await destroyAllSessionsFor(database, user.id);
  const session = await createSession(database, user.id, {
    userAgent: request.headers.get('user-agent'),
    ipAddress: clientAddress ?? null,
  });
  setSessionCookie(cookies, url, session.token, session.expiresAt);

  await recordAuth(database, {
    action: 'auth.password.changed',
    outcome: 'ok',
    userId: user.id,
    email: user.email,
    ip: clientAddress ?? null,
    userAgent: request.headers.get('user-agent'),
    extra: { wasForced: user.mustChangePassword },
  });

  return redirect('/account/password?changed=1', 302);
};
