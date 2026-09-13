import { describe, it, expect } from 'vitest';
import {
  scoreMatch,
  proposeMatches,
  mentionsInvoice,
  mentionsClient,
  CONFIDENT,
  type MatchableInvoice,
} from '~/lib/bank/match';
import type { BankRow } from '~/lib/bank/csv';

const $ = (d: number) => Math.round(d * 100);

const row = (over: Partial<BankRow> = {}): BankRow => ({
  date: '2026-03-12',
  amount: $(1_150),
  description: 'Acme Design Ltd',
  reference: '',
  fingerprint: 'fp1',
  ...over,
});

const invoice = (over: Partial<MatchableInvoice> = {}): MatchableInvoice => ({
  id: 'i1',
  number: 'INV-0042',
  reference: '',
  clientName: 'Acme Design Limited',
  currency: 'NZD',
  outstanding: $(1_150),
  issuedOn: '2026-02-26',
  dueOn: '2026-03-12',
  ...over,
});

describe('mentionsInvoice', () => {
  it('finds the number however the bank mangled it', () => {
    for (const text of ['INV-0042', 'inv0042', 'INV 0042', 'Payment inv42', 'ref 0042']) {
      expect(mentionsInvoice(text, 'INV-0042')).toBe(true);
    }
  });

  it('does not match on a short number, which would hit everything', () => {
    expect(mentionsInvoice('order 7 of 12', 'INV-7')).toBe(false);
  });

  it('says no when the number is absent', () => {
    expect(mentionsInvoice('Acme Design monthly', 'INV-0042')).toBe(false);
    expect(mentionsInvoice('', 'INV-0042')).toBe(false);
  });
});

describe('mentionsClient', () => {
  it('matches on a distinctive word', () => {
    expect(mentionsClient('ACME DESIGN LTD', 'Acme Design Limited')).toBe(true);
  });

  it('ignores the words every second company shares', () => {
    // Otherwise "Limited" would match every client on the list.
    expect(mentionsClient('Fernwood Limited', 'Kowhai Studio Limited')).toBe(false);
  });

  it('copes with no client name', () => {
    expect(mentionsClient('anything', null)).toBe(false);
  });
});

describe('scoreMatch', () => {
  it('is confident when the amount matches and the number is in the reference', () => {
    const match = scoreMatch(row({ reference: 'INV-0042' }), invoice());
    expect(match).not.toBeNull();
    expect(match!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
    expect(match!.signals).toContain('exact-amount');
    expect(match!.signals).toContain('invoice-number');
  });

  it('is NOT confident on an exact amount alone', () => {
    // Two invoices for the same round figure — a retainer, a standard
    // package — are exactly where a silent mis-match happens.
    const match = scoreMatch(
      row({ description: 'Internet banking transfer', reference: '' }),
      invoice({ clientName: null }),
    );
    expect(match).not.toBeNull();
    expect(match!.confidence).toBeLessThan(CONFIDENT);
  });

  it('ignores money going out', () => {
    expect(scoreMatch(row({ amount: -$(1_150) }), invoice())).toBeNull();
  });

  it('ignores an invoice with nothing owing', () => {
    expect(scoreMatch(row(), invoice({ outstanding: 0 }))).toBeNull();
  });

  it('refuses a credit larger than the balance, which is a judgement for a person', () => {
    expect(scoreMatch(row({ amount: $(2_000) }), invoice({ outstanding: $(1_150) }))).toBeNull();
  });

  it('offers a corroborated part payment, but not as a certainty', () => {
    const match = scoreMatch(
      row({ amount: $(500), description: 'Acme Design Ltd' }),
      invoice({ outstanding: $(1_150) }),
    );
    expect(match?.partial).toBe(true);
    expect(match!.confidence).toBeLessThan(CONFIDENT);
  });

  it('does not offer an uncorroborated part payment at all', () => {
    // Any credit smaller than the balance "partly matches" every larger
    // invoice. Without something tying it to this one it is just noise.
    const match = scoreMatch(
      row({ amount: $(37.5), description: 'Transfer', reference: '' }),
      invoice({ outstanding: $(1_150), clientName: null }),
    );
    expect(match).toBeNull();
  });

  it('lets a part payment become confident with the invoice number on it', () => {
    const match = scoreMatch(
      row({ amount: $(500), reference: 'INV-0042 part' }),
      invoice({ outstanding: $(1_150) }),
    );
    expect(match!.signals).toContain('invoice-number');
    expect(match!.partial).toBe(true);
  });

  it('explains itself in words a person can check', () => {
    const match = scoreMatch(row({ reference: 'INV-0042' }), invoice());
    expect(match!.reason).toMatch(/amount matches exactly/);
    expect(match!.reason).toMatch(/invoice number/);
  });
});

describe('proposeMatches', () => {
  it('will not mark two equally-matching invoices as certain', () => {
    // The evidence does not distinguish them, so saying "probably this one"
    // is precisely the mistake worth avoiding.
    const matches = proposeMatches(
      [row({ description: 'Transfer', reference: '' })],
      [
        invoice({ id: 'a', number: 'INV-0041', clientName: null }),
        invoice({ id: 'b', number: 'INV-0042', clientName: null }),
      ],
      'NZD',
    );
    const proposals = matches[0]!.proposals;
    expect(proposals.length).toBeGreaterThan(1);
    for (const proposal of proposals) {
      expect(proposal.confidence).toBeLessThan(CONFIDENT);
    }
    expect(proposals[0]!.reason).toMatch(/just as well/);
  });

  it('picks the right one when the reference distinguishes them', () => {
    const matches = proposeMatches(
      [row({ reference: 'INV-0042' })],
      [invoice({ id: 'a', number: 'INV-0041' }), invoice({ id: 'b', number: 'INV-0042' })],
      'NZD',
    );
    expect(matches[0]!.proposals[0]).toMatchObject({ invoiceId: 'b' });
    expect(matches[0]!.proposals[0]!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  });

  it('never proposes one invoice as settled by two different credits', () => {
    const matches = proposeMatches(
      [
        row({ fingerprint: 'fp1', reference: 'INV-0042' }),
        row({ fingerprint: 'fp2', reference: 'unrelated' }),
      ],
      [invoice()],
      'NZD',
    );
    const proposed = matches.flatMap((m) => m.proposals.map((p) => p.invoiceId));
    expect(proposed).toEqual(['i1']);
  });

  it('does not cross currencies', () => {
    const matches = proposeMatches([row()], [invoice({ currency: 'AUD' })], 'NZD');
    expect(matches[0]!.proposals).toHaveLength(0);
  });

  it('drops debits entirely', () => {
    const matches = proposeMatches([row({ amount: -$(84.2) })], [invoice()], 'NZD');
    expect(matches).toHaveLength(0);
  });

  it('returns an empty proposal list rather than a bad guess', () => {
    const matches = proposeMatches(
      [row({ amount: $(37.5), description: 'Spotify' })],
      [invoice()],
      'NZD',
    );
    expect(matches[0]!.proposals).toHaveLength(0);
  });
});
