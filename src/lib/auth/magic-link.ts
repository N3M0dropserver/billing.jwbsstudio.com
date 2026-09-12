/**
 * Sign in by email link.
 *
 * The link proves control of the mailbox, which for this app is the same
 * assurance a password gives — the account is provisioned against one
 * address by the administrator and there is no sign-up. It also gives you a
 * way back in when the password is lost or the account has locked itself.
 *
 * Shape of the thing:
 *  - 32 random bytes, URL-safe, in the path of the emailed link.
 *  - Only the SHA-256 is stored, exactly as for session tokens.
 *  - Single use: redeeming it stamps `consumed_at` and drops every other
 *    outstanding link for that user, so the newest request wins and an old
 *    mail sitting in an inbox is inert.
 *  - Short lived: fifteen minutes.
 *
 * Note on link scanners: corporate mail filters and some clients fetch URLs
 * in a message before the recipient sees it, which redeems a one-shot link.
 * This app mails to its own operators rather than through a filtered
 * corporate tenant, so the link is redeemed on GET. If that changes, the fix
 * is a confirmation page that posts the token rather than a plain GET.
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { loginTokens, users, type User } from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';
import { hashToken } from '~/lib/auth/session';
import { fingerprint } from '~/lib/auth/log';

/** How long an emailed link stays valid. */
export const LINK_TTL_MINUTES = 15;
/** Links a single account may request inside the window below. */
const MAX_LINKS_PER_WINDOW = 5;
const REQUEST_WINDOW_MINUTES = 15;

export interface IssuedLink {
  token: string;
  tokenFingerprint: string;
  expiresAt: Date;
}

export type IssueFailure = { ok: false; reason: 'link-rate-limited'; activeCount: number };
export type IssueResult = ({ ok: true } & IssuedLink) | IssueFailure;

/**
 * Mint a link for a user that has already been looked up.
 *
 * The caller is responsible for not revealing whether the lookup succeeded —
 * see the request route, which answers identically either way.
 */
export async function issueMagicLink(
  db: Db,
  user: User,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<IssueResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Housekeeping first, so the rate-limit count below only sees live links.
  // Spent links are left until they expire, so redeeming one twice can still
  // be reported as "already used" rather than "never heard of it".
  await db
    .delete(loginTokens)
    .where(and(eq(loginTokens.userId, user.id), lt(loginTokens.expiresAt, nowIso)));

  const windowStart = new Date(now - REQUEST_WINDOW_MINUTES * 60_000).toISOString();
  const active = await db
    .select({ id: loginTokens.id })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.userId, user.id),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.createdAt, windowStart),
      ),
    );

  if (active.length >= MAX_LINKS_PER_WINDOW) {
    return { ok: false, reason: 'link-rate-limited', activeCount: active.length };
  }

  const token = newToken(32);
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(now + LINK_TTL_MINUTES * 60_000);

  await db.insert(loginTokens).values({
    id: newId(),
    userId: user.id,
    purpose: 'magic-link',
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
    requestedIp: meta.ip ?? null,
    requestedUserAgent: meta.userAgent?.slice(0, 500) ?? null,
    createdAt: nowIso,
  });

  return { ok: true, token, tokenFingerprint: fingerprint(tokenHash), expiresAt };
}

export type ConsumeFailure = {
  ok: false;
  reason: 'link-unknown' | 'link-expired' | 'link-used' | 'account-disabled';
  userId?: string;
  tokenFingerprint: string;
};
export type ConsumeResult = { ok: true; user: User; tokenFingerprint: string } | ConsumeFailure;

/**
 * Redeem a link. Every refusal names itself, because "that link did not
 * work" is a uselessly ambiguous thing to be told about your own account.
 */
export async function consumeMagicLink(db: Db, token: string): Promise<ConsumeResult> {
  const tokenHash = await hashToken(token);
  const fp = fingerprint(tokenHash);

  const rows = await db
    .select({ link: loginTokens, user: users })
    .from(loginTokens)
    .innerJoin(users, eq(loginTokens.userId, users.id))
    .where(eq(loginTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: 'link-unknown', tokenFingerprint: fp };

  if (row.link.consumedAt) {
    return { ok: false, reason: 'link-used', userId: row.user.id, tokenFingerprint: fp };
  }

  if (new Date(row.link.expiresAt).getTime() <= Date.now()) {
    await db.delete(loginTokens).where(eq(loginTokens.id, row.link.id));
    return { ok: false, reason: 'link-expired', userId: row.user.id, tokenFingerprint: fp };
  }

  if (row.user.disabledAt) {
    return { ok: false, reason: 'account-disabled', userId: row.user.id, tokenFingerprint: fp };
  }

  // Stamp this one as spent, then clear the rest — requesting a new link
  // should invalidate the older mails sitting in the inbox.
  await db
    .update(loginTokens)
    .set({ consumedAt: new Date().toISOString() })
    .where(eq(loginTokens.id, row.link.id));

  await db
    .delete(loginTokens)
    .where(and(eq(loginTokens.userId, row.user.id), isNull(loginTokens.consumedAt)));

  return { ok: true, user: row.user, tokenFingerprint: fp };
}

/** The URL that goes in the email. */
export function magicLinkUrl(appUrl: string, token: string, next: string): string {
  const url = new URL(`/login/link/${encodeURIComponent(token)}`, appUrl);
  if (next && next !== '/') url.searchParams.set('next', next);
  return url.toString();
}

/** Housekeeping: drop links that are spent or past their expiry. */
export async function purgeStaleLoginTokens(db: Db): Promise<void> {
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, new Date().toISOString()));
}
