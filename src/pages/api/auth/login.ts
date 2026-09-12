import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { verifyPassword, needsRehash, hashPassword } from '~/lib/auth/password';
import {
  SESSION_COOKIE,
  createSession,
  findUserByEmail,
  isLockedOut,
  recordFailedAttempt,
  recordSuccessfulLogin,
  sessionCookieOptions,
} from '~/lib/auth/session';
import { users, activityLog } from '~/lib/db/schema';
import { eq } from 'drizzle-orm';
import { newId } from '~/lib/id';

export const prerender = false;

/** Only allow same-origin relative paths, so `next` cannot become an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  const raw = typeof value === 'string' ? value : '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const next = safeNext(form.get('next'));

  const fail = (reason: string) =>
    redirect(`/login?error=${reason}&next=${encodeURIComponent(next)}`, 302);

  if (!email || !password) return fail('invalid');

  const database = db();
  const user = await findUserByEmail(database, email);

  if (!user) {
    // Burn comparable time on an unknown email so the response time does not
    // reveal whether the account exists.
    await verifyPassword(password, 'pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return fail('invalid');
  }

  if (user.disabledAt) return fail('disabled');
  if (isLockedOut(user)) return fail('locked');

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordFailedAttempt(database, user);
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

  const session = await createSession(database, user.id, {
    userAgent: request.headers.get('user-agent'),
    ipAddress: clientAddress ?? null,
  });

  cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

  await database.insert(activityLog).values({
    id: newId(),
    userId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    detail: '{}',
    ipAddress: clientAddress ?? null,
    createdAt: new Date().toISOString(),
  });

  return redirect(user.mustChangePassword ? '/account/password' : next, 302);
};
