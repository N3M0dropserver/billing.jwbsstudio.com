/**
 * Deciding which invoices to chase today.
 *
 * Chasing late payers is the single most valuable thing this software can do
 * for a one-person studio, and the job you are least likely to do by hand:
 * it is tedious, it feels rude, and it always happens on the day you are busy.
 *
 * Everything here is pure. It takes the invoices, the settings and today's
 * date, and returns a list of decisions — no database, no email, no clock.
 * That is deliberate: a system that sends mail to your clients on a schedule
 * has to be testable without sending any, and "what would it do on 14 March"
 * has to be answerable.
 *
 * The ladder
 * ----------
 * One courtesy note a few days BEFORE the due date, then chases at a set
 * number of days AFTER it. Each rung fires at most once, identified by name
 * (`before-3`, `after-14`) and recorded on the invoice — a day count alone
 * cannot tell you whether you already chased on day 7, and a sweep that runs
 * twice, or misses a day and catches up, must not send twice or skip a rung.
 *
 * The most overdue rung that is due and unsent wins, so an invoice that has
 * been sitting unpaid while reminders were switched off gets one chase at the
 * right severity rather than four in a row.
 */

import type { Invoice } from '~/lib/db/schema';

export type ReminderKind = 'before-due' | 'overdue';

export interface ReminderRung {
  /** Stable name, stored on the invoice once sent. */
  stage: string;
  kind: ReminderKind;
  /** Negative before the due date, positive after it. */
  offsetDays: number;
}

export interface ReminderSettings {
  remindersEnabled: boolean;
  reminderDaysBefore: number;
  /** JSON array of day counts, as stored. Parsed defensively. */
  reminderDaysAfter: string;
  reminderMaxCount: number;
  reminderSkipWeekends: boolean;
}

export type SkipReason =
  | 'reminders-off'
  | 'invoice-paused'
  | 'client-opted-out'
  | 'no-email'
  | 'never-sent'
  | 'not-outstanding'
  | 'cancelled'
  | 'draft'
  | 'max-reached'
  | 'weekend'
  | 'nothing-due'
  | 'already-sent';

export interface ReminderDecision {
  invoiceId: string;
  send: boolean;
  rung?: ReminderRung;
  reason?: SkipReason;
  /** Whole days past the due date. Negative before it. */
  daysOverdue: number;
}

/** The default ladder, used when the stored value is unusable. */
export const DEFAULT_DAYS_AFTER = [7, 14, 30];

/**
 * Parse the stored ladder.
 *
 * It is a JSON array in a text column, which means it can be anything at all
 * by the time it comes back. Nonsense falls back to the default rather than
 * throwing inside a scheduled job, where nobody is watching to see it throw.
 */
export function parseDaysAfter(raw: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DAYS_AFTER;
  }
  if (!Array.isArray(parsed)) return DEFAULT_DAYS_AFTER;

  const days = parsed
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 3650)
    .map((v) => Math.round(v));

  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : DEFAULT_DAYS_AFTER;
}

/** Every rung of the ladder, earliest first. */
export function ladderFor(settings: ReminderSettings): ReminderRung[] {
  const rungs: ReminderRung[] = [];

  const before = Math.round(settings.reminderDaysBefore);
  if (Number.isFinite(before) && before > 0) {
    rungs.push({ stage: `before-${before}`, kind: 'before-due', offsetDays: -before });
  }

  for (const day of parseDaysAfter(settings.reminderDaysAfter)) {
    rungs.push({ stage: `after-${day}`, kind: 'overdue', offsetDays: day });
  }

  return rungs;
}

/** Whole days between two ISO dates, positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function isWeekend(isoDate: string): boolean {
  const day = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export interface ChasableInvoice
  extends Pick<
    Invoice,
    | 'id'
    | 'status'
    | 'dueOn'
    | 'total'
    | 'amountPaid'
    | 'sentAt'
    | 'remindersSent'
    | 'lastReminderStage'
    | 'remindersPaused'
  > {
  /** From the client record; null when there is nobody to write to. */
  clientEmail: string | null;
  clientRemindersEnabled: boolean;
}

/**
 * Should this invoice be chased today, and with which rung?
 *
 * Refusals are named rather than collapsed into false, for the same reason
 * the auth code names them: "we sent nothing today" and "we sent nothing
 * today because every client has opted out" look identical from outside and
 * are completely different problems.
 */
export function decideReminder(
  invoice: ChasableInvoice,
  settings: ReminderSettings,
  today: string,
): ReminderDecision {
  const daysOverdue = daysBetween(invoice.dueOn, today);
  const skip = (reason: SkipReason): ReminderDecision => ({
    invoiceId: invoice.id,
    send: false,
    reason,
    daysOverdue,
  });

  if (!settings.remindersEnabled) return skip('reminders-off');
  if (invoice.remindersPaused) return skip('invoice-paused');
  if (!invoice.clientRemindersEnabled) return skip('client-opted-out');
  if (!invoice.clientEmail) return skip('no-email');

  if (invoice.status === 'draft') return skip('draft');
  if (invoice.status === 'void' || invoice.status === 'written-off') return skip('cancelled');

  // Never chase an invoice the client has not been sent. Reminding someone
  // about a document they have never seen is worse than saying nothing.
  if (!invoice.sentAt) return skip('never-sent');

  if (invoice.total - invoice.amountPaid <= 0) return skip('not-outstanding');
  if (invoice.remindersSent >= Math.max(settings.reminderMaxCount, 0)) return skip('max-reached');

  const rungs = ladderFor(settings);
  const sentAlready = invoice.lastReminderStage;

  /**
   * Rungs whose day has arrived. The LAST one wins: an invoice left unchased
   * for six weeks — because reminders were off, or the sweep did not run —
   * gets one chase pitched at six weeks late, not four in a row working up
   * to it.
   */
  const due = rungs.filter((rung) => daysOverdue >= rung.offsetDays);
  const rung = due[due.length - 1];
  if (!rung) return skip('nothing-due');

  if (sentAlready === rung.stage) return skip('already-sent');

  /**
   * If the rung we would send is one we have already passed — the stored
   * stage is at or beyond it — there is nothing new to say.
   */
  if (sentAlready) {
    const sentIndex = rungs.findIndex((r) => r.stage === sentAlready);
    const rungIndex = rungs.findIndex((r) => r.stage === rung.stage);
    if (sentIndex >= 0 && rungIndex <= sentIndex) return skip('already-sent');
  }

  /**
   * Weekends last, so a chase that comes due on a Saturday is held to Monday
   * rather than skipped: the rung stays due on Monday, and this same check
   * passes then.
   */
  if (settings.reminderSkipWeekends && isWeekend(today)) return skip('weekend');

  return { invoiceId: invoice.id, send: true, rung, daysOverdue };
}

export interface SweepSummary {
  considered: number;
  sent: number;
  failed: number;
  skipped: Record<string, number>;
}

export function emptySummary(): SweepSummary {
  return { considered: 0, sent: 0, failed: 0, skipped: {} };
}

export function countSkip(summary: SweepSummary, reason: SkipReason): void {
  summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
}
