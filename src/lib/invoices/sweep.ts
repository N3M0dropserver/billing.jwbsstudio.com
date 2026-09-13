/**
 * The scheduled side of chasing: read, decide, send, record.
 *
 * The deciding is in `reminders.ts` and is pure. This file is the I/O around
 * it — deliberately thin, so the part with the judgement in it can be tested
 * without a database or a mail provider.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { invoices, clients, settings as settingsTable, communications, activityLog } from '~/lib/db/schema';
import type { Settings } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { sendMail } from '~/lib/mail';
import { reminderEmail } from '~/lib/mail/templates';
import { renderInvoicePdf } from '~/lib/pdf/invoice';
import { toPdfData } from '~/lib/invoices/pdf-data';
import { getInvoice } from '~/lib/invoices/service';
import {
  decideReminder,
  emptySummary,
  countSkip,
  type ChasableInvoice,
  type SweepSummary,
} from '~/lib/invoices/reminders';

export interface SweepOptions {
  /** ISO date to treat as today. Defaults to the real one. */
  today?: string;
  /** Decide and report, send nothing. */
  dryRun?: boolean;
  /** Ceiling on messages per run, so a misconfiguration cannot mail everyone. */
  limit?: number;
}

export interface SweepResult extends SweepSummary {
  today: string;
  dryRun: boolean;
  /** One line per invoice that was or would be chased. */
  actions: Array<{
    invoiceId: string;
    number: string;
    stage: string;
    daysOverdue: number;
    to: string;
    ok: boolean;
    error?: string;
  }>;
}

/**
 * Chase everything that is due to be chased, for one user.
 *
 * A hard ceiling of 25 messages per run. If something is wrong — a bad
 * ladder, a clock skew, a restored backup full of old invoices — the damage
 * is 25 emails, not the entire client list. The remainder is picked up on the
 * next run, by which time you will have seen the log.
 */
export async function runReminderSweep(
  db: Db,
  env: Env,
  appUrl: string,
  userSettings: Settings,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(options.limit ?? 25, 25);
  const summary = emptySummary();
  const result: SweepResult = { ...summary, today, dryRun: Boolean(options.dryRun), actions: [] };

  const rows = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      dueOn: invoices.dueOn,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      sentAt: invoices.sentAt,
      remindersSent: invoices.remindersSent,
      lastReminderStage: invoices.lastReminderStage,
      remindersPaused: invoices.remindersPaused,
      number: invoices.number,
      clientEmail: clients.email,
      clientRemindersEnabled: clients.remindersEnabled,
    })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(
      and(
        eq(invoices.userId, userSettings.userId),
        ne(invoices.status, 'draft'),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'written-off'),
        ne(invoices.status, 'paid'),
        // Outstanding balance only. Cheaper to ask the database than to read
        // every invoice ever raised into memory each night.
        sql`${invoices.total} > ${invoices.amountPaid}`,
      ),
    );

  result.considered = rows.length;

  for (const row of rows) {
    const candidate: ChasableInvoice = {
      ...row,
      clientEmail: row.clientEmail || null,
      clientRemindersEnabled: row.clientRemindersEnabled ?? true,
    };

    const decision = decideReminder(candidate, userSettings, today);
    if (!decision.send || !decision.rung) {
      if (decision.reason) countSkip(result, decision.reason);
      continue;
    }

    if (result.sent >= limit) {
      countSkip(result, 'nothing-due');
      continue;
    }

    if (options.dryRun) {
      result.sent += 1;
      result.actions.push({
        invoiceId: row.id,
        number: row.number,
        stage: decision.rung.stage,
        daysOverdue: decision.daysOverdue,
        to: candidate.clientEmail!,
        ok: true,
      });
      continue;
    }

    const sendResult = await sendOneReminder(db, env, appUrl, userSettings, row.id, decision.daysOverdue);

    if (sendResult.ok) {
      result.sent += 1;
      await db
        .update(invoices)
        .set({
          remindersSent: row.remindersSent + 1,
          lastReminderAt: new Date().toISOString(),
          lastReminderStage: decision.rung.stage,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(invoices.id, row.id));
    } else {
      result.failed += 1;
    }

    result.actions.push({
      invoiceId: row.id,
      number: row.number,
      stage: decision.rung.stage,
      daysOverdue: decision.daysOverdue,
      to: candidate.clientEmail!,
      ok: sendResult.ok,
      error: sendResult.error,
    });
  }

  await db.insert(activityLog).values({
    id: newId(),
    userId: userSettings.userId,
    action: options.dryRun ? 'reminders.swept.dry-run' : 'reminders.swept',
    entityType: 'invoice',
    detail: JSON.stringify({
      today,
      considered: result.considered,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
    }),
    createdAt: new Date().toISOString(),
  });

  return result;
}

async function sendOneReminder(
  db: Db,
  env: Env,
  appUrl: string,
  userSettings: Settings,
  invoiceId: string,
  daysOverdue: number,
): Promise<{ ok: boolean; error?: string }> {
  const invoice = await getInvoice(db, userSettings.userId, invoiceId);
  if (!invoice?.client?.email) return { ok: false, error: 'No client email.' };

  const payUrl = invoice.publicToken ? `${appUrl}/pay/${invoice.publicToken}` : undefined;
  const pdf = renderInvoicePdf(toPdfData(invoice, userSettings, { payUrl }));

  const content = reminderEmail({
    invoiceNumber: invoice.number,
    clientName: invoice.client.name,
    businessName: userSettings.businessName || 'Your business',
    senderName: userSettings.businessName || 'Accounts',
    total: invoice.total - invoice.amountPaid,
    currency: invoice.currency,
    dueOn: invoice.dueOn,
    viewUrl: payUrl ?? appUrl,
    payUrl: userSettings.stripeEnabled ? payUrl : undefined,
    daysOverdue: Math.max(daysOverdue, 0),
  });

  const sent = await sendMail(env, {
    to: invoice.client.email,
    toName: invoice.client.name,
    subject: content.subject,
    text: content.text,
    html: content.html,
    replyTo: userSettings.email || undefined,
    attachments: [
      { filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' },
    ],
  });

  if (!sent.ok) return { ok: false, error: sent.error };

  const now = new Date().toISOString();
  if (invoice.clientId) {
    await db.insert(communications).values({
      id: newId(),
      userId: userSettings.userId,
      clientId: invoice.clientId,
      kind: 'invoice-sent',
      subject: content.subject,
      body: `Automatic payment reminder, ${Math.max(daysOverdue, 0)} days past due.`,
      occurredAt: now,
      createdAt: now,
    });
  }

  return { ok: true };
}

/** Every user with reminders switched on. */
export async function usersWithRemindersEnabled(db: Db): Promise<Settings[]> {
  return db.select().from(settingsTable).where(eq(settingsTable.remindersEnabled, true));
}
