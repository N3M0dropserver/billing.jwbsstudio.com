/**
 * Reading the activity log.
 *
 * Two tables feed one timeline. `invoice_events` holds what happened to an
 * invoice and what the client did with it; `communications` holds the calls,
 * meetings and notes you logged by hand. They are queried separately and
 * merged here rather than joined in SQL, because they share no key — the only
 * thing they have in common is a client and a point in time, which is exactly
 * what the merge uses.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { clients, communications, invoiceEvents, invoices } from '~/lib/db/schema';
import {
  describeEventType,
  parseDetail,
  summariseEvent,
  type EventTone,
  type InvoiceEventActor,
  type InvoiceEventType,
} from './events';

export interface TimelineEntry {
  id: string;
  /** ISO-8601 UTC, newest first once merged. */
  at: string;
  label: string;
  /** The one-line detail under the label. May be empty. */
  note: string;
  tone: EventTone;
  actor: InvoiceEventActor;
  source: 'invoice' | 'communication';
  /** The raw type, for filtering and for the icon. */
  kind: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  clientId: string | null;
  clientName: string | null;
}

/** How a hand-logged communication reads on the timeline. */
const COMMUNICATION_LABELS: Record<string, string> = {
  email: 'Email logged',
  call: 'Call logged',
  meeting: 'Meeting logged',
  note: 'Note',
  'proposal-sent': 'Proposal sent',
  'invoice-sent': 'Invoice sent',
  'follow-up': 'Follow-up',
};

type EventRow = typeof invoiceEvents.$inferSelect;
type CommunicationRow = typeof communications.$inferSelect;

function fromEvent(
  row: EventRow,
  context: { invoiceNumber?: string | null; clientName?: string | null } = {},
): TimelineEntry {
  const described = describeEventType(row.type);
  return {
    id: row.id,
    at: row.occurredAt,
    label: described.label,
    note: summariseEvent(row.type, parseDetail(row.detail)),
    tone: described.tone,
    actor: row.actor,
    source: 'invoice',
    kind: row.type,
    invoiceId: row.invoiceId,
    invoiceNumber: context.invoiceNumber ?? null,
    clientId: row.clientId,
    clientName: context.clientName ?? null,
  };
}

function fromCommunication(
  row: CommunicationRow,
  context: { clientName?: string | null } = {},
): TimelineEntry {
  const label = COMMUNICATION_LABELS[row.kind] ?? row.kind;
  return {
    id: row.id,
    at: row.occurredAt,
    // A hand-written subject is more specific than the generic kind label,
    // so it wins the headline and the kind falls back to the icon.
    label: row.subject || label,
    note: row.body,
    tone: row.kind === 'follow-up' ? 'outbound' : 'neutral',
    actor: 'user',
    source: 'communication',
    kind: row.kind,
    invoiceId: null,
    invoiceNumber: null,
    clientId: row.clientId,
    clientName: context.clientName ?? null,
  };
}

/** Newest first, with a stable tiebreak so equal timestamps do not shuffle. */
export function mergeTimeline(...groups: TimelineEntry[][]): TimelineEntry[] {
  return groups
    .flat()
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
}

/** Everything that has happened to one invoice, newest first. */
export async function invoiceTimeline(db: Db, invoiceId: string): Promise<TimelineEntry[]> {
  const rows = await db
    .select()
    .from(invoiceEvents)
    .where(eq(invoiceEvents.invoiceId, invoiceId))
    .orderBy(desc(invoiceEvents.occurredAt))
    .limit(200);

  return mergeTimeline(rows.map((row) => fromEvent(row)));
}

/**
 * One client's history: their invoice events and their logged communications,
 * interleaved.
 */
export async function clientTimeline(
  db: Db,
  clientId: string,
  limit = 40,
): Promise<TimelineEntry[]> {
  const [eventRows, commsRows] = await Promise.all([
    db
      .select({ event: invoiceEvents, invoiceNumber: invoices.number })
      .from(invoiceEvents)
      .leftJoin(invoices, eq(invoiceEvents.invoiceId, invoices.id))
      .where(eq(invoiceEvents.clientId, clientId))
      .orderBy(desc(invoiceEvents.occurredAt))
      .limit(limit),
    db
      .select()
      .from(communications)
      .where(eq(communications.clientId, clientId))
      .orderBy(desc(communications.occurredAt))
      .limit(limit),
  ]);

  return mergeTimeline(
    eventRows.map((row) => fromEvent(row.event, { invoiceNumber: row.invoiceNumber })),
    commsRows.map((row) => fromCommunication(row)),
  ).slice(0, limit);
}

export type ActivityFilter = 'all' | 'outbound' | 'client' | 'money';

const FILTER_TYPES: Record<Exclude<ActivityFilter, 'all'>, InvoiceEventType[]> = {
  outbound: ['sent', 'reminder-sent', 'send-failed'],
  client: ['email-opened', 'viewed', 'pdf-downloaded', 'payment-started'],
  money: ['payment-recorded', 'paid'],
};

export function isActivityFilter(value: string | null | undefined): value is ActivityFilter {
  return value === 'all' || value === 'outbound' || value === 'client' || value === 'money';
}

/**
 * The whole account's activity feed.
 *
 * `outbound` and `client` are invoice events only, so hand-logged
 * communications are left out of those two deliberately — a logged phone call
 * is neither an email you sent nor something the client did to an invoice.
 */
export async function recentActivity(
  db: Db,
  userId: string,
  options: { limit?: number; filter?: ActivityFilter } = {},
): Promise<TimelineEntry[]> {
  const limit = options.limit ?? 100;
  const filter = options.filter ?? 'all';

  const conditions = [eq(invoices.userId, userId)];
  if (filter !== 'all') conditions.push(inArray(invoiceEvents.type, FILTER_TYPES[filter]));

  // Scoped through the invoice rather than invoice_events.user_id, because
  // client-side events have no user on them at all.
  const eventRows = await db
    .select({ event: invoiceEvents, invoiceNumber: invoices.number, clientName: clients.name })
    .from(invoiceEvents)
    .innerJoin(invoices, eq(invoiceEvents.invoiceId, invoices.id))
    .leftJoin(clients, eq(invoiceEvents.clientId, clients.id))
    .where(and(...conditions))
    .orderBy(desc(invoiceEvents.occurredAt))
    .limit(limit);

  const entries = eventRows.map((row) =>
    fromEvent(row.event, { invoiceNumber: row.invoiceNumber, clientName: row.clientName }),
  );

  if (filter !== 'all') return mergeTimeline(entries).slice(0, limit);

  const commsRows = await db
    .select({ communication: communications, clientName: clients.name })
    .from(communications)
    .leftJoin(clients, eq(communications.clientId, clients.id))
    .where(eq(communications.userId, userId))
    .orderBy(desc(communications.occurredAt))
    .limit(limit);

  return mergeTimeline(
    entries,
    commsRows.map((row) => fromCommunication(row.communication, { clientName: row.clientName })),
  ).slice(0, limit);
}

/**
 * When this invoice last saw an event of this type, for the repeat window.
 * `parentId` narrows an email open to one particular send.
 */
export async function lastEventAt(
  db: Db,
  invoiceId: string,
  type: InvoiceEventType,
  parentId?: string,
): Promise<string | null> {
  const conditions = [eq(invoiceEvents.invoiceId, invoiceId), eq(invoiceEvents.type, type)];
  if (parentId) conditions.push(eq(invoiceEvents.parentId, parentId));

  const rows = await db
    .select({ occurredAt: invoiceEvents.occurredAt })
    .from(invoiceEvents)
    .where(and(...conditions))
    .orderBy(desc(invoiceEvents.occurredAt))
    .limit(1);

  return rows[0]?.occurredAt ?? null;
}

export interface EngagementSummary {
  emailOpens: number;
  webViews: number;
  pdfDownloads: number;
  /** The most recent thing the client did, of any kind. */
  lastClientActivityAt: string | null;
}

/** The "have they looked at it" line, in one query rather than four. */
export async function invoiceEngagement(db: Db, invoiceId: string): Promise<EngagementSummary> {
  const rows = await db
    .select({
      type: invoiceEvents.type,
      count: sql<number>`count(*)`,
      lastAt: sql<string>`max(${invoiceEvents.occurredAt})`,
    })
    .from(invoiceEvents)
    .where(
      and(
        eq(invoiceEvents.invoiceId, invoiceId),
        inArray(invoiceEvents.type, ['email-opened', 'viewed', 'pdf-downloaded', 'payment-started']),
      ),
    )
    .groupBy(invoiceEvents.type);

  const byType = new Map(rows.map((row) => [row.type, row]));
  const lastAt = rows
    .map((row) => row.lastAt)
    .filter(Boolean)
    .sort()
    .pop();

  return {
    emailOpens: byType.get('email-opened')?.count ?? 0,
    webViews: byType.get('viewed')?.count ?? 0,
    pdfDownloads: byType.get('pdf-downloaded')?.count ?? 0,
    lastClientActivityAt: lastAt ?? null,
  };
}
