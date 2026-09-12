/**
 * Session management.
 *
 * A session token is 32 random bytes. The RAW token goes in an HttpOnly
 * cookie; only its SHA-256 is stored in D1. A database leak therefore does
 * not hand anyone a working session, the same reasoning as hashing passwords.
 */

import { eq, lt, and } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { sessions, users, type User, type Session } from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';

export const SESSION_COOKIE = '__Host-jwbs_session';
const SESSION_DAYS = 14;
/** Re-issue the expiry when a session is more than halfway through its life. */
const REFRESH_AFTER_DAYS = 7;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<CreatedSession> {
  const token = newToken(32);
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db.insert(sessions).values({
    id: newId(),
    userId,
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
    ipAddress: meta.ipAddress ?? null,
    createdAt: new Date().toISOString(),
  });

  return { token, expiresAt };
}

export interface ResolvedSession {
  user: User;
  session: Session;
  /** Set when the session was extended and the cookie should be re-sent. */
  refreshedExpiry?: Date;
}

export async function resolveSession(
  db: Db,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (new Date(row.session.expiresAt).getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }

  // A disabled account must not keep a live session.
  if (row.user.disabledAt) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }

  const expiresAt = new Date(row.session.expiresAt).getTime();
  const remaining = expiresAt - now;
  let refreshedExpiry: Date | undefined;

  if (remaining < REFRESH_AFTER_DAYS * 86_400_000) {
    refreshedExpiry = new Date(now + SESSION_DAYS * 86_400_000);
    await db
      .update(sessions)
      .set({ expiresAt: refreshedExpiry.toISOString() })
      .where(eq(sessions.id, row.session.id));
  }

  return { user: row.user, session: row.session, refreshedExpiry };
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  const tokenHash = await hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/** Kill every session for a user — used when a password changes. */
export async function destroyAllSessionsFor(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping: drop sessions that have already expired. */
export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
}

export const sessionCookieOptions = (expiresAt: Date) =>
  ({
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    expires: expiresAt,
  });

/* ------------------------------------------------------------------ */
/* Brute force protection                                              */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export function isLockedOut(user: User): boolean {
  if (!user.lockedUntil) return false;
  return new Date(user.lockedUntil).getTime() > Date.now();
}

export async function recordFailedAttempt(db: Db, user: User): Promise<void> {
  const attempts = user.failedAttempts + 1;
  const lockedUntil =
    attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : user.lockedUntil;

  await db
    .update(users)
    .set({ failedAttempts: attempts, lockedUntil, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id));
}

export async function recordSuccessfulLogin(db: Db, user: User): Promise<void> {
  await db
    .update(users)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, user.id));
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email.trim().toLowerCase())))
    .limit(1);
  return rows[0] ?? null;
}
