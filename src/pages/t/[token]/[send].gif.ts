import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { invoiceEvents, invoices } from '~/lib/db/schema';
import { isNewOccurrence, recordInvoiceEvent } from '~/lib/activity/events';
import { identifyProxy, pixelResponse } from '~/lib/activity/tracking';
import { lastEventAt } from '~/lib/activity/timeline';

export const prerender = false;

/**
 * The email open pixel: `/t/<public token>/<send event id>.gif`.
 *
 * Unauthenticated, like the pay page — the invoice's public token is the
 * credential, and this route never reveals anything, not even whether the
 * token is real. Every request gets the same 42-byte image and the same 200,
 * so it cannot be used to enumerate tokens and never renders as a broken
 * image in a client's inbox.
 *
 * Recording an open is entirely best effort. A logging failure must not turn
 * into a visible defect in an email that has already been delivered.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const response = pixelResponse();

  try {
    const token = params.token ?? '';
    const sendEventId = params.send ?? '';
    if (!token || !sendEventId) return response;

    const database = db();

    // One query proves three things at once: the send event exists, it is a
    // send rather than some other event, and it belongs to the invoice this
    // token opens. A pixel URL from one invoice therefore cannot log an open
    // against another.
    const rows = await database
      .select({
        eventId: invoiceEvents.id,
        eventType: invoiceEvents.type,
        invoiceId: invoices.id,
        clientId: invoices.clientId,
        number: invoices.number,
      })
      .from(invoiceEvents)
      .innerJoin(invoices, eq(invoiceEvents.invoiceId, invoices.id))
      .where(and(eq(invoiceEvents.id, sendEventId), eq(invoices.publicToken, token)))
      .limit(1);

    const send = rows[0];
    if (!send || (send.eventType !== 'sent' && send.eventType !== 'reminder-sent')) {
      return response;
    }

    // A mail client that re-renders the message refetches the image every
    // time. Collapse those into one row per visit.
    const previous = await lastEventAt(database, send.invoiceId, 'email-opened', send.eventId);
    if (!isNewOccurrence(previous)) return response;

    const userAgent = request.headers.get('user-agent');
    const proxy = identifyProxy(userAgent);

    await recordInvoiceEvent(database, {
      invoiceId: send.invoiceId,
      clientId: send.clientId,
      type: 'email-opened',
      actor: 'client',
      parentId: send.eventId,
      detail: {
        send: send.eventType === 'reminder-sent' ? 'reminder' : 'invoice',
        ...(proxy ? { proxy } : {}),
      },
      ipAddress: request.headers.get('cf-connecting-ip'),
      userAgent,
    });
  } catch (error) {
    console.error(`[activity] open pixel failed: ${String(error)}`);
  }

  return response;
};
