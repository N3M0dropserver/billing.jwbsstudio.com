import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { invoices } from '~/lib/db/schema';
import { recordOpen } from '~/lib/queries/sends';
import { pixelBytes } from '~/lib/mail/tracking';
import { isNewOccurrence, recordInvoiceEvent } from '~/lib/activity/events';
import { lastEventAt } from '~/lib/activity/timeline';
import { identifyProxy } from '~/lib/activity/tracking';

export const prerender = false;

/**
 * The open-tracking pixel.
 *
 * Unauthenticated by design — the caller is a mail client, and the token in
 * the URL is the only credential. An unknown token is not an error worth
 * reporting; it returns the same image as a known one, so probing this
 * endpoint reveals nothing about which tokens exist.
 *
 * One hit updates two records, because a send has two of them: the row in
 * `email_sends`, which counts opens and judges whether the fetch looks like a
 * prefetch, and — when the send was an invoice — an `email-opened` entry on
 * that invoice's timeline, under the send it belongs to. They share an id, so
 * this one token reaches both. Read both with the suspicion the numbers
 * deserve; see src/lib/mail/tracking.ts on why an open is a weak signal.
 *
 * The image is returned whatever happens. A database failure must not leave a
 * broken-image icon in a client's inbox — the tracking is the optional part
 * here, not the pixel.
 */
export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const token = (params.token ?? '').slice(0, 200);

  if (token) {
    try {
      const userAgent = request.headers.get('user-agent');
      const ip = clientAddress ?? null;
      const send = await recordOpen(db(), token, { userAgent, ip });

      if (send && send.entityType === 'invoice') {
        const database = db();

        // A mail client that re-renders the message refetches the image every
        // time. Collapse those into one entry per visit.
        const previous = await lastEventAt(database, send.entityId, 'email-opened', send.id);

        if (isNewOccurrence(previous)) {
          const rows = await database
            .select({ clientId: invoices.clientId })
            .from(invoices)
            .where(eq(invoices.id, send.entityId))
            .limit(1);

          const proxy = identifyProxy(userAgent);

          await recordInvoiceEvent(database, {
            invoiceId: send.entityId,
            clientId: rows[0]?.clientId ?? null,
            type: 'email-opened',
            actor: 'client',
            parentId: send.id,
            detail: proxy ? { proxy } : {},
            ipAddress: ip,
            userAgent,
          });
        }
      }
    } catch {
      // Never let a tracking failure show up in someone's email.
    }
  }

  return new Response(pixelBytes() as BodyInit, {
    headers: {
      'content-type': 'image/gif',
      // Must not be cached anywhere, or repeat opens never reach us. Gmail's
      // proxy caches regardless; this at least stops everything else.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      expires: '0',
    },
  });
};
