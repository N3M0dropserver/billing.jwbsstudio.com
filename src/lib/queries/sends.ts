import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { emailSends, type EmailSend } from '~/lib/db/schema';
import { newId, newToken } from '~/lib/id';
import { looksLikePrefetch } from '~/lib/mail/tracking';

/**
 * Records of messages sent, and the opens attributed to them.
 *
 * A row is written *before* the message goes out, because the tracking token
 * has to exist in order to be embedded in the body. That means a row can exist
 * for a send that then failed at the provider — `provider` stays empty in that
 * case, and `recordFailure` notes why.
 */

export interface NewSend {
  /**
   * Optional, so a caller that also writes an activity event for this send can
   * give both records the same identity. The open pixel then only has to carry
   * one token to update both. See src/pages/e/[token].gif.ts.
   */
  id?: string;
  /**
   * Optional for the same reason as `id`: a caller that has to know the
   * tracking URL before it renders the body can mint the token first.
   */
  token?: string;
  userId: string;
  entityType: 'invoice' | 'proposal' | 'client' | 'test';
  entityId: string;
  templateId: string | null;
  toAddress: string;
  subject: string;
}

export async function startSend(db: Db, input: NewSend): Promise<EmailSend> {
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? newId(),
    userId: input.userId,
    entityType: input.entityType,
    entityId: input.entityId,
    templateId: input.templateId,
    toAddress: input.toAddress,
    subject: input.subject,
    token: input.token ?? newToken(18),
    provider: '',
    providerMessageId: null,
    sentAt: now,
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    openUserAgent: null,
    openIp: null,
    likelyPrefetch: false,
    createdAt: now,
  };
  await db.insert(emailSends).values(row);
  return row as EmailSend;
}

export async function completeSend(
  db: Db,
  id: string,
  provider: string,
  providerMessageId?: string,
): Promise<void> {
  await db
    .update(emailSends)
    .set({ provider, providerMessageId: providerMessageId ?? null })
    .where(eq(emailSends.id, id));
}

/**
 * The provider refused the message. The row is kept rather than deleted — a
 * failed send is a thing you want to see when a client says they never got it.
 */
export async function recordFailure(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(emailSends)
    .set({ provider: `failed: ${error}`.slice(0, 300) })
    .where(eq(emailSends.id, id));
}

export async function sendsFor(
  db: Db,
  userId: string,
  entityType: EmailSend['entityType'],
  entityId: string,
): Promise<EmailSend[]> {
  return db
    .select()
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        eq(emailSends.entityType, entityType),
        eq(emailSends.entityId, entityId),
      ),
    )
    .orderBy(desc(emailSends.sentAt));
}

/**
 * Attribute a pixel load to a send.
 *
 * `first_opened_at` is only ever written once, so the timestamp keeps meaning
 * "the first time this was seen" no matter how many times the image reloads.
 * The count is incremented in SQL rather than read-modify-written, so
 * concurrent loads cannot lose one.
 *
 * Unauthenticated by design — the token is the only credential, and the caller
 * is a mail client, not a session.
 */
/**
 * Note the open against the send this token belongs to.
 *
 * Returns the send as it was BEFORE the update, or null for a token that
 * matches nothing, so the caller can decide what else this open means — the
 * pixel route uses it to add the matching entry to an invoice's timeline.
 */
export async function recordOpen(
  db: Db,
  token: string,
  meta: { userAgent: string | null; ip: string | null },
): Promise<EmailSend | null> {
  const rows = await db.select().from(emailSends).where(eq(emailSends.token, token)).limit(1);
  const send = rows[0];
  if (!send) return null;

  const now = new Date().toISOString();
  const first = !send.firstOpenedAt;

  await db
    .update(emailSends)
    .set({
      firstOpenedAt: send.firstOpenedAt ?? now,
      lastOpenedAt: now,
      openCount: sql`${emailSends.openCount} + 1`,
      // Only the first hit describes the opener; later ones are re-renders.
      openUserAgent: first ? meta.userAgent : send.openUserAgent,
      openIp: first ? meta.ip : send.openIp,
      likelyPrefetch: first ? looksLikePrefetch(meta.userAgent, send.sentAt) : send.likelyPrefetch,
    })
    .where(eq(emailSends.id, send.id));

  return send;
}
