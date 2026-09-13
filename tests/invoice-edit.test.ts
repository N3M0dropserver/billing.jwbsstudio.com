import { describe, it, expect } from 'vitest';
import { editability, EDIT_REFUSAL_MESSAGE } from '~/lib/invoices/service';
import { deriveStatus } from '~/lib/invoices/calculate';

const $ = (d: number) => Math.round(d * 100);

describe('editability', () => {
  it('allows a draft and an unpaid sent invoice to be corrected', () => {
    expect(editability({ status: 'draft', amountPaid: 0 }).canEdit).toBe(true);
    expect(editability({ status: 'sent', amountPaid: 0 }).canEdit).toBe(true);
    expect(editability({ status: 'overdue', amountPaid: 0 }).canEdit).toBe(true);
  });

  it('refuses once money has been recorded against it', () => {
    const result = editability({ status: 'partial', amountPaid: $(100) });
    expect(result).toEqual({ canEdit: false, reason: 'has-payments' });
  });

  it('refuses a voided or written-off invoice', () => {
    expect(editability({ status: 'void', amountPaid: 0 })).toEqual({
      canEdit: false,
      reason: 'void',
    });
    expect(editability({ status: 'written-off', amountPaid: 0 })).toEqual({
      canEdit: false,
      reason: 'written-off',
    });
  });

  it('has a message for every refusal, so the UI can never show "undefined"', () => {
    for (const reason of ['has-payments', 'void', 'written-off'] as const) {
      expect(EDIT_REFUSAL_MESSAGE[reason]).toBeTruthy();
    }
  });
});

describe('void and write-off are terminal', () => {
  const base = {
    total: $(1_000),
    amountPaid: 0,
    dueOn: '2020-01-01',
    sentAt: '2019-12-01T00:00:00Z',
    viewedAt: null,
  };

  it('does not let a voided invoice drift back to overdue on its own', () => {
    expect(deriveStatus({ ...base, status: 'void' })).toBe('void');
  });

  it('keeps a written-off invoice written off', () => {
    expect(deriveStatus({ ...base, status: 'written-off' })).toBe('written-off');
  });

  it('still ages an ordinary unpaid invoice into overdue', () => {
    expect(deriveStatus({ ...base, status: 'sent' })).toBe('overdue');
  });
});
