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
import { communications, invoiceEvents, invoices } from '~/lib/db/schema';
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
  /** The raw event or communication type, which chooses the icon. */
  kind: string;
  invoiceId: string | null;
  /** Set only where the timeline spans more than one invoice. */
  invoiceNumber: string | null;
  clientId: string | null;
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
  context: { invoiceNumber?: string | null } = {},
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
  };
}

function fromCommunication(row: CommunicationRow): TimelineEntry {
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
