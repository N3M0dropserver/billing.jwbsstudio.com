import { describe, it, expect } from 'vitest';
import {
  decideReminder,
  ladderFor,
  parseDaysAfter,
  daysBetween,
  DEFAULT_DAYS_AFTER,
  type ChasableInvoice,
  type ReminderSettings,
} from '~/lib/invoices/reminders';

const $ = (d: number) => Math.round(d * 100);

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
  remindersEnabled: true,
  reminderDaysBefore: 3,
  reminderDaysAfter: '[7,14,30]',
  reminderMaxCount: 4,
  reminderSkipWeekends: false,
  ...over,
});

const invoice = (over: Partial<ChasableInvoice> = {}): ChasableInvoice => ({
  id: 'inv1',
  status: 'sent',
  dueOn: '2026-09-01',
  total: $(1_000),
  amountPaid: 0,
  sentAt: '2026-08-18T00:00:00Z',
  remindersSent: 0,
  lastReminderStage: null,
  remindersPaused: false,
  clientEmail: 'client@example.com',
  clientRemindersEnabled: true,
  ...over,
});

describe('parseDaysAfter', () => {
  it('reads a normal ladder', () => {
    expect(parseDaysAfter('[7,14,30]')).toEqual([7, 14, 30]);
  });

  it('sorts and de-duplicates', () => {
    expect(parseDaysAfter('[30,7,7,14]')).toEqual([7, 14, 30]);
  });

  it('falls back rather than throwing inside a scheduled job', () => {
    // Nobody is watching a cron run throw at 8am.
    for (const bad of ['', 'null', '{}', '"7"', '[]', '[0]', '[-5]', 'not json']) {
      expect(parseDaysAfter(bad)).toEqual(DEFAULT_DAYS_AFTER);
    }
  });

  it('drops nonsense entries but keeps the good ones', () => {
    expect(parseDaysAfter('[7,"x",null,14,-1,0]')).toEqual([7, 14]);
  });
});

describe('ladderFor', () => {
  it('puts the courtesy note before the chases', () => {
    const rungs = ladderFor(settings());
    expect(rungs.map((r) => r.stage)).toEqual(['before-3', 'after-7', 'after-14', 'after-30']);
    expect(rungs[0]?.offsetDays).toBe(-3);
  });

  it('omits the courtesy note when it is set to zero', () => {
    const rungs = ladderFor(settings({ reminderDaysBefore: 0 }));
    expect(rungs.map((r) => r.stage)).toEqual(['after-7', 'after-14', 'after-30']);
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-01', '2026-09-08')).toBe(7);
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
    expect(daysBetween('2026-09-01', '2026-08-29')).toBe(-3);
  });

  it('is not thrown off by a daylight-saving boundary', () => {
    // NZ moves its clocks on 27 September 2026. Dates are handled in UTC, so
    // the count must still be exact across it.
    expect(daysBetween('2026-09-26', '2026-09-28')).toBe(2);
  });
});

describe('decideReminder', () => {
  it('sends the courtesy note three days before due', () => {
    const decision = decideReminder(invoice(), settings(), '2026-08-29');
    expect(decision.send).toBe(true);
    expect(decision.rung?.stage).toBe('before-3');
  });

  it('says nothing before the courtesy note is due', () => {
    const decision = decideReminder(invoice(), settings(), '2026-08-20');
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('nothing-due');
  });

  it('chases at seven days overdue', () => {
    const decision = decideReminder(
      invoice({ lastReminderStage: 'before-3', remindersSent: 1 }),
      settings(),
      '2026-09-08',
    );
    expect(decision.send).toBe(true);
    expect(decision.rung?.stage).toBe('after-7');
    expect(decision.daysOverdue).toBe(7);
  });

  it('does not send the same rung twice', () => {
    const decision = decideReminder(
      invoice({ lastReminderStage: 'after-7', remindersSent: 2 }),
      settings(),
      '2026-09-08',
    );
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('already-sent');
  });

  it('does not go backwards down the ladder', () => {
    // A sweep that runs late must not send day 7 after day 14 has gone.
    const decision = decideReminder(
      invoice({ lastReminderStage: 'after-14', remindersSent: 3 }),
      settings(),
      '2026-09-09',
    );
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('already-sent');
  });

  it('sends ONE chase at the right severity after a long silence', () => {
    // Reminders were off for six weeks. The client should get one note
    // pitched at six weeks late, not four in a row working up to it.
    const decision = decideReminder(invoice(), settings(), '2026-10-15');
    expect(decision.send).toBe(true);
    expect(decision.rung?.stage).toBe('after-30');
  });

  it('never chases an invoice the client was never sent', () => {
    const decision = decideReminder(invoice({ sentAt: null }), settings(), '2026-09-08');
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('never-sent');
  });

  it('stops once the invoice is settled', () => {
    const decision = decideReminder(
      invoice({ amountPaid: $(1_000) }),
      settings(),
      '2026-09-08',
    );
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('not-outstanding');
  });

  it('still chases a partial payment', () => {
    const decision = decideReminder(invoice({ amountPaid: $(400) }), settings(), '2026-09-08');
    expect(decision.send).toBe(true);
  });

  it('respects the per-invoice pause and the per-client opt-out', () => {
    expect(decideReminder(invoice({ remindersPaused: true }), settings(), '2026-09-08').reason)
      .toBe('invoice-paused');
    expect(
      decideReminder(invoice({ clientRemindersEnabled: false }), settings(), '2026-09-08').reason,
    ).toBe('client-opted-out');
  });

  it('sends nothing at all while the feature is switched off', () => {
    const decision = decideReminder(
      invoice(),
      settings({ remindersEnabled: false }),
      '2026-10-15',
    );
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('reminders-off');
  });

  it('will not chase a void or written-off invoice', () => {
    expect(decideReminder(invoice({ status: 'void' }), settings(), '2026-09-08').reason)
      .toBe('cancelled');
    expect(decideReminder(invoice({ status: 'written-off' }), settings(), '2026-09-08').reason)
      .toBe('cancelled');
    expect(decideReminder(invoice({ status: 'draft' }), settings(), '2026-09-08').reason)
      .toBe('draft');
  });

  it('says nothing when there is nobody to write to', () => {
    expect(decideReminder(invoice({ clientEmail: null }), settings(), '2026-09-08').reason)
      .toBe('no-email');
    expect(decideReminder(invoice({ clientEmail: '' }), settings(), '2026-09-08').reason)
      .toBe('no-email');
  });

  it('honours the ceiling however long the ladder is', () => {
    const decision = decideReminder(
      invoice({ remindersSent: 4, lastReminderStage: 'after-14' }),
      settings({ reminderMaxCount: 4 }),
      '2026-10-15',
    );
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('max-reached');
  });

  it('holds a weekend chase rather than dropping it', () => {
    // 12 September 2026 is a Saturday; the 14th is the Monday.
    const held = decideReminder(invoice(), settings({ reminderSkipWeekends: true }), '2026-09-12');
    expect(held.send).toBe(false);
    expect(held.reason).toBe('weekend');

    const monday = decideReminder(invoice(), settings({ reminderSkipWeekends: true }), '2026-09-14');
    expect(monday.send).toBe(true);
    expect(monday.rung?.stage).toBe('after-7');
  });

  it('walks a whole invoice through the ladder without repeating itself', () => {
    const sentStages: string[] = [];
    let current = invoice();

    // Every day from a week before due to six weeks after.
    for (let offset = -7; offset <= 42; offset++) {
      const today = new Date(Date.parse('2026-09-01T00:00:00Z') + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const decision = decideReminder(current, settings(), today);
      if (decision.send && decision.rung) {
        sentStages.push(decision.rung.stage);
        current = {
          ...current,
          lastReminderStage: decision.rung.stage,
          remindersSent: current.remindersSent + 1,
        };
      }
    }

    expect(sentStages).toEqual(['before-3', 'after-7', 'after-14', 'after-30']);
    expect(new Set(sentStages).size).toBe(sentStages.length);
  });
});
