/**
 * Session management.
 *
 * A session token is 32 random bytes. The RAW token goes in an HttpOnly
 * cookie; only its SHA-256 is stored in D1. A database leak therefore does
 * not hand anyone a working session, the same reasoning as hashing passwords.
 */

import { eq, lt, and } from 'drizzle-orm';
import type { AstroCookies } from 'astro';
import type { Db } from '~/lib/db';
import { sessions, users, type User, type Session } from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';

/**
 * The production cookie name. The `__Host-` prefix is a browser-enforced
 * guarantee: the cookie must be Secure, must have Path=/ and must carry no
 * Domain, so no sibling subdomain can overwrite it.
 *
 * That prefix also makes the cookie unsettable over plain http. Chrome and
 * Firefox make an exception for localhost; Safari does not, and silently
 * drops the cookie — which looks exactly like "my password is wrong", except
 * the password was right and the redirect just bounces you back to /login.
 * So over http we fall back to an unprefixed, non-Secure name. Sessions are
 * database-backed, so the two names are interchangeable at the lookup end.
 */
export const SESSION_COOKIE = '__Host-jwbs_session';
/** Insecure-origin fallback. Only ever used on http:// — i.e. local dev. */
export const SESSION_COOKIE_INSECURE = 'jwbs_session_dev';

const SESSION_DAYS = 14;
/** Re-issue the expiry when a session is more than halfway through its life. */
const REFRESH_AFTER_DAYS = 7;

export function isSecureOrigin(url: URL): boolean {
  return url.protocol === 'https:';
}

export function sessionCookieName(url: URL): string {
  return isSecureOrigin(url) ? SESSION_COOKIE : SESSION_COOKIE_INSECURE;
}

/**
 * Read the session token under whichever name is in play, tolerating a
 * cookie left over from the other scheme so switching between `wrangler dev`
 * and the deployed Worker does not strand a browser.
 */
export function readSessionToken(cookies: AstroCookies, url: URL): string | undefined {
  return (
    cookies.get(sessionCookieName(url))?.value ??
    cookies.get(isSecureOrigin(url) ? SESSION_COOKIE_INSECURE : SESSION_COOKIE)?.value
  );
}

export function setSessionCookie(cookies: AstroCookies, url: URL, token: string, expiresAt: Date): void {
  cookies.set(sessionCookieName(url), token, sessionCookieOptions(expiresAt, url));
}

export function clearSessionCookie(cookies: AstroCookies, url: URL): void {
  // A deletion is just a cookie with a past expiry, so it has to carry the
  // same attributes as the original — a `__Host-` cookie sent back without
  // Secure is rejected outright, and the live one would survive the logout.
  const attributes = { path: '/', httpOnly: true, secure: isSecureOrigin(url), sameSite: 'lax' as const };
  cookies.delete(sessionCookieName(url), attributes);
  // Drop the other name too, so a stale cookie cannot resurrect a session.
  cookies.delete(isSecureOrigin(url) ? SESSION_COOKIE_INSECURE : SESSION_COOKIE, attributes);
}

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

export type SessionRejection =
  | 'no-cookie'
  | 'unknown-token'
  | 'session-expired'
  | 'account-disabled';

/**
 * Either a live session, or the reason there is not one. The reason is the
 * whole point: "no cookie arrived" and "the cookie names a session we have
 * never heard of" are the same 302 to the user and completely different
 * problems to whoever is debugging.
 */
export type SessionLookup =
  | { session: ResolvedSession; reason?: undefined }
  | { session: null; reason: SessionRejection };

export async function resolveSession(
  db: Db,
  token: string | undefined,
): Promise<SessionLookup> {
  if (!token) return { session: null, reason: 'no-cookie' };

  const tokenHash = await hashToken(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return { session: null, reason: 'unknown-token' };

  const now = Date.now();
  if (new Date(row.session.expiresAt).getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return { session: null, reason: 'session-expired' };
  }

  // A disabled account must not keep a live session.
  if (row.user.disabledAt) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return { session: null, reason: 'account-disabled' };
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

  return { session: { user: row.user, session: row.session, refreshedExpiry } };
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

export const sessionCookieOptions = (expiresAt: Date, url: URL) =>
  ({
    path: '/',
    httpOnly: true,
    secure: isSecureOrigin(url),
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
