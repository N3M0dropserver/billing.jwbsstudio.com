/**
 * Auth logging.
 *
 * Authentication is the one part of the app that fails silently by design: a
 * wrong password, a rejected cookie and a browser that never stored the
 * cookie in the first place all look identical from the outside, which is
 * exactly what you want facing an attacker and exactly what you do not want
 * when you are trying to sign in yourself. So every decision the auth code
 * makes is written out here with a machine-readable reason.
 *
 * Two destinations:
 *
 *   console     — one JSON line per event, prefixed `[auth]`. Visible in
 *                 `wrangler tail` and in Workers Observability, which is
 *                 already enabled in wrangler.jsonc. Always written, and
 *                 never dependent on the database being reachable.
 *   activity_log — the durable audit trail, for events tied to a real user.
 *                 Best effort: a logging failure must never break a sign-in.
 *
 * What is never logged: passwords, raw session tokens, raw magic-link tokens.
 * Tokens are identified by a short fingerprint of their hash instead, which
 * is enough to follow one token across several log lines and useless to
 * anyone who finds it.
 */

import type { Db } from '~/lib/db';
import { activityLog } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export type AuthOutcome = 'ok' | 'denied' | 'error';

/**
 * Why a request was refused. These are stable identifiers — grep for them,
 * and do not reword one without checking the login page's message map.
 */
export type AuthReason =
  // Credentials
  | 'missing-fields'
  | 'unknown-email'
  | 'bad-password'
  | 'account-disabled'
  | 'account-locked'
  // Sessions
  | 'no-cookie'
  | 'unknown-token'
  | 'session-expired'
  // Magic links
  | 'link-unknown'
  | 'link-expired'
  | 'link-used'
  | 'link-rate-limited'
  | 'mail-failed'
  | 'mail-disabled'
  // Environment
  | 'no-db-binding';

export interface AuthEvent {
  /** Dotted action name, e.g. `auth.login` or `auth.magic-link.request`. */
  action: string;
  outcome: AuthOutcome;
  reason?: AuthReason;
  /** Free text safe to put in a log — never a secret. */
  detail?: string;
  userId?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Short, non-reversible identifier for a token involved in the event. */
  tokenFingerprint?: string | null;
  path?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * First 8 hex characters of a token's SHA-256. Enough to correlate the
 * "issued" and "redeemed" lines for one link; far too little to reverse.
 */
export function fingerprint(tokenHash: string): string {
  return tokenHash.slice(0, 8);
}

function line(event: AuthEvent): string {
  const payload: Record<string, unknown> = {
    at: new Date().toISOString(),
    action: event.action,
    outcome: event.outcome,
  };
  if (event.reason) payload.reason = event.reason;
  if (event.detail) payload.detail = event.detail;
  if (event.userId) payload.userId = event.userId;
  if (event.email) payload.email = event.email;
  if (event.ip) payload.ip = event.ip;
  if (event.path) payload.path = event.path;
  if (event.tokenFingerprint) payload.token = event.tokenFingerprint;
  if (event.userAgent) payload.userAgent = event.userAgent.slice(0, 200);
  if (event.extra) Object.assign(payload, event.extra);

  return `[auth] ${JSON.stringify(payload)}`;
}

/**
 * Console only. Use where there is no database — the middleware's missing
 * binding path, most obviously, where reaching for `db()` would throw.
 */
export function logAuth(event: AuthEvent): void {
  const text = line(event);
  if (event.outcome === 'error') console.error(text);
  else if (event.outcome === 'denied') console.warn(text);
  else console.log(text);
}

/**
 * Console plus the audit table.
 *
 * Wrapped so a failed insert degrades to a console line rather than a 500 —
 * losing an audit row is bad, failing to let someone in because the audit
 * row would not write is worse.
 */
export async function recordAuth(db: Db, event: AuthEvent): Promise<void> {
  logAuth(event);

  const detail: Record<string, unknown> = { outcome: event.outcome };
  if (event.reason) detail.reason = event.reason;
  if (event.detail) detail.detail = event.detail;
  if (event.email) detail.email = event.email;
  if (event.tokenFingerprint) detail.token = event.tokenFingerprint;
  if (event.userAgent) detail.userAgent = event.userAgent.slice(0, 200);
  if (event.extra) Object.assign(detail, event.extra);

  try {
    await db.insert(activityLog).values({
      id: newId(),
      userId: event.userId ?? null,
      action: event.action,
      entityType: 'user',
      entityId: event.userId ?? '',
      detail: JSON.stringify(detail),
      ipAddress: event.ip ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    logAuth({
      action: 'auth.audit.write-failed',
      outcome: 'error',
      detail: String(error),
      extra: { forAction: event.action },
    });
  }
}
