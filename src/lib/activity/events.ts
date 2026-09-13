/**
 * The invoice activity log — what went out, and what the client did with it.
 *
 * Writes are best effort. Losing an activity row is annoying; failing to send
 * an invoice because the activity row would not write is worse, and a client
 * seeing a 500 on the public pay page because a log insert failed is worse
 * still. So every helper here swallows its own errors onto the console rather
 * than letting them escape. The one exception is `createdEventStatement`,
 * which belongs inside the atomic batch that creates the invoice.
 *
 * Nothing in this module reads the request body or any credential. What it
 * does store about the client — IP and user agent — is kept because "who
 * viewed it" is the whole point of the log, and is truncated on the way in.
 */

import type { Db } from '~/lib/db';
import { formatMoneyWithCode, type Currency } from '~/lib/tax/money';
import { invoiceEvents, type InvoiceEvent } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export type InvoiceEventType = InvoiceEvent['type'];
export type InvoiceEventActor = InvoiceEvent['actor'];

/** A user agent is stored to tell a mail scanner from a person, not to profile. */
const MAX_USER_AGENT = 200;

export interface RecordEventInput {
  invoiceId: string;
  clientId?: string | null;
  /** Null for anything the client did — they have no account here. */
  userId?: string | null;
  type: InvoiceEventType;
  actor?: InvoiceEventActor;
  detail?: Record<string, unknown>;
  /** The `sent` event a client-side event belongs to. */
  parentId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt?: string;
  /** Supply the id up front when it has to be known before the row exists. */
  id?: string;
}

/** The row to insert, built without touching the database. Exported for tests. */
export function buildEvent(input: RecordEventInput): typeof invoiceEvents.$inferInsert {
  return {
    id: input.id ?? newId(),
    invoiceId: input.invoiceId,
    clientId: input.clientId ?? null,
    userId: input.userId ?? null,
    type: input.type,
    actor: input.actor ?? (input.userId ? 'user' : 'client'),
    detail: JSON.stringify(input.detail ?? {}),
    parentId: input.parentId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT) : null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}

/**
 * Write one event. Returns the id it used, so a caller that pre-generated one
 * (the tracking pixel URL needs the id before the row exists) can rely on it.
 */
export async function recordInvoiceEvent(db: Db, input: RecordEventInput): Promise<string> {
  const row = buildEvent(input);
  try {
    await db.insert(invoiceEvents).values(row);
  } catch (error) {
    console.error(
      `[activity] failed to record ${row.type} for invoice ${row.invoiceId}: ${String(error)}`,
    );
  }
  return row.id;
}

/**
 * The `created` event as a statement, for the batch that creates an invoice.
 * Inside the batch it is atomic with the invoice itself, which is what you
 * want: an invoice that exists but has no beginning to its history would be a
 * gap in the record rather than a missing convenience.
 */
export function createdEventStatement(db: Db, input: RecordEventInput) {
  return db.insert(invoiceEvents).values(buildEvent(input));
}

/* ------------------------------------------------------------------ */
/* Repeat suppression                                                  */
/* ------------------------------------------------------------------ */

/**
 * How long the same client-side event is treated as one visit.
 *
 * A person reading an invoice reloads, hits back, opens the PDF and comes
 * back — one interest, not five. Anything after the window is a fresh look
 * and worth a row, because "they came back to it twice this week" is a
 * genuine signal when you are deciding whether to chase.
 */
export const REPEAT_WINDOW_MINUTES = 30;

/**
 * Whether a repeat of the same event is far enough from the last one to be
 * worth its own row. Pure, so the window is testable without a database.
 */
export function isNewOccurrence(
  lastOccurredAt: string | null | undefined,
  now: Date | string = new Date(),
  windowMinutes = REPEAT_WINDOW_MINUTES,
): boolean {
  if (!lastOccurredAt) return true;

  const last = new Date(lastOccurredAt).getTime();
  const at = new Date(now).getTime();
  if (!Number.isFinite(last) || !Number.isFinite(at)) return true;

  // A clock skew that puts the last event in the future must not lock the log
  // shut, so only a gap inside the window suppresses.
  return at - last >= windowMinutes * 60_000 || at < last;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

export type EventTone = 'neutral' | 'outbound' | 'engagement' | 'money' | 'problem';

interface EventDescription {
  label: string;
  tone: EventTone;
  /** Who the row is about, for the "you / them" split in the UI. */
  actor: InvoiceEventActor;
}

const DESCRIPTIONS: Record<InvoiceEventType, EventDescription> = {
  created: { label: 'Invoice created', tone: 'neutral', actor: 'user' },
  sent: { label: 'Invoice sent', tone: 'outbound', actor: 'user' },
  'reminder-sent': { label: 'Reminder sent', tone: 'outbound', actor: 'user' },
  'send-failed': { label: 'Send failed', tone: 'problem', actor: 'system' },
  'email-opened': { label: 'Client opened the email', tone: 'engagement', actor: 'client' },
  viewed: { label: 'Client viewed the web invoice', tone: 'engagement', actor: 'client' },
  'pdf-downloaded': { label: 'Client downloaded the PDF', tone: 'engagement', actor: 'client' },
  'payment-started': { label: 'Client started a card payment', tone: 'engagement', actor: 'client' },
  'payment-recorded': { label: 'Payment recorded', tone: 'money', actor: 'user' },
  paid: { label: 'Paid in full', tone: 'money', actor: 'system' },
  note: { label: 'Note', tone: 'neutral', actor: 'user' },
};

export function describeEventType(type: InvoiceEventType): EventDescription {
  return DESCRIPTIONS[type] ?? { label: type, tone: 'neutral', actor: 'system' };
}

/** Every type, in a stable order, for the filter UI. */
export const INVOICE_EVENT_TYPES = Object.keys(DESCRIPTIONS) as InvoiceEventType[];

/** The types the client caused, which are the ones worth a notification. */
export const CLIENT_EVENT_TYPES: InvoiceEventType[] = INVOICE_EVENT_TYPES.filter(
  (type) => describeEventType(type).actor === 'client',
);

/** Parse a stored detail blob without letting bad JSON reach a page. */
export function parseDetail(detail: string | null | undefined): Record<string, unknown> {
  if (!detail) return {};
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The one-line detail under an event's label.
 *
 * Everything here comes out of the event's own `detail` blob, which is
 * written by this app — but it is JSON that has been round-tripped through
 * the database, so each field is checked rather than trusted.
 */
export function summariseEvent(
  type: InvoiceEventType,
  detail: Record<string, unknown>,
): string {
  const text = (key: string): string =>
    typeof detail[key] === 'string' ? (detail[key] as string) : '';
  const cents = (key: string): number | null =>
    typeof detail[key] === 'number' && Number.isFinite(detail[key] as number)
      ? (detail[key] as number)
      : null;
  const currency = (): Currency => (detail.currency === 'AUD' ? 'AUD' : 'NZD');

  switch (type) {
    case 'created': {
      const total = cents('total');
      return total === null ? '' : formatMoneyWithCode(total, currency());
    }
    case 'sent':
    case 'reminder-sent': {
      const to = text('to');
      return to ? `To ${to}` : '';
    }
    case 'send-failed': {
      const reason = text('error') || text('reason');
      const to = text('to');
      return [to && `To ${to}`, reason].filter(Boolean).join(' — ');
    }
    case 'email-opened': {
      const proxy = text('proxy');
      return proxy
        ? `Fetched by a ${proxy}, which may mean the image was loaded rather than read`
        : 'Remote images were loaded — weaker evidence than a web view';
    }
    case 'viewed':
      return detail.first === true ? 'First time they opened the link' : '';
    case 'pdf-downloaded':
      return '';
    case 'payment-started': {
      const amount = cents('amount');
      return amount === null ? '' : `Checkout for ${formatMoneyWithCode(amount, currency())}`;
    }
    case 'payment-recorded': {
      const amount = cents('amount');
      const method = text('method');
      return [amount === null ? '' : formatMoneyWithCode(amount, currency()), method]
        .filter(Boolean)
        .join(' · ');
    }
    case 'paid': {
      const total = cents('total');
      return total === null ? '' : `${formatMoneyWithCode(total, currency())} settled in full`;
    }
    default:
      return text('note');
  }
}
