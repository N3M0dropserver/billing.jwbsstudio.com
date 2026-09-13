/**
 * Matching bank credits to outstanding invoices.
 *
 * The judgement here is deliberately conservative. Recording a payment
 * against the wrong invoice is worse than recording none: it marks one client
 * paid who has not paid, leaves another chased who has, and the error is
 * invisible until somebody complains. So a match is only ever a PROPOSAL with
 * a stated confidence and stated reasons, and only an exact-amount match with
 * corroborating evidence is offered as confident enough to accept in bulk.
 *
 * Pure. Rows and invoices in, proposals out.
 */

import type { Cents, Currency } from '~/lib/tax/money';
import type { BankRow } from './csv';

export interface MatchableInvoice {
  id: string;
  number: string;
  reference: string;
  clientName: string | null;
  currency: Currency;
  /** What is still owed, in the invoice's own currency. */
  outstanding: Cents;
  issuedOn: string;
  dueOn: string;
}

export type MatchSignal =
  | 'exact-amount'
  | 'invoice-number'
  | 'reference'
  | 'client-name'
  | 'near-due-date'
  | 'partial-amount';

export interface MatchProposal {
  fingerprint: string;
  invoiceId: string;
  invoiceNumber: string;
  /** 0..1. Only >= CONFIDENT is offered for one-click acceptance in bulk. */
  confidence: number;
  signals: MatchSignal[];
  /** What the payment would record. */
  amount: Cents;
  /** True when this settles less than the full balance. */
  partial: boolean;
  reason: string;
}

/** At or above this, a match is safe to accept without reading it. */
export const CONFIDENT = 0.8;

/** Normalise text for comparison: lowercase, alphanumerics only. */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Does the statement text contain this invoice number?
 *
 * Bank references get truncated, stripped of punctuation and upper-cased on
 * the way through the payments system, so `INV-0042` arrives as `INV0042`,
 * `inv 42` or just `0042`. The comparison is made on squashed text, and a
 * bare numeric tail only counts when it is at least three digits — matching
 * on "7" would hit everything.
 */
export function mentionsInvoice(text: string, invoiceNumber: string): boolean {
  const haystack = squash(text);
  if (!haystack) return false;

  const needle = squash(invoiceNumber);
  if (needle && haystack.includes(needle)) return true;

  const digits = invoiceNumber.replace(/\D+/g, '');
  if (digits.length >= 3) {
    if (haystack.includes(digits)) return true;
    // `INV-0042` paid as `inv42`: try it without leading zeros too.
    const trimmed = digits.replace(/^0+/, '');
    if (trimmed.length >= 2 && haystack.includes(trimmed)) return true;
  }

  return false;
}

/** Do any distinctive words of the client name appear in the statement text? */
export function mentionsClient(text: string, clientName: string | null): boolean {
  if (!clientName) return false;
  const haystack = squash(text);
  if (!haystack) return false;

  const words = clientName
    .split(/\s+/)
    .map(squash)
    // Skip the words every second company shares.
    .filter((word) => word.length >= 4 && !['limited', 'ltd', 'pty', 'group', 'the'].includes(word));

  return words.some((word) => haystack.includes(word));
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((b - a) / 86_400_000));
}

function describe(signals: MatchSignal[], partial: boolean): string {
  const parts: string[] = [];
  if (signals.includes('exact-amount')) parts.push('the amount matches exactly');
  if (signals.includes('partial-amount')) parts.push('the amount is part of the balance');
  if (signals.includes('invoice-number')) parts.push('the invoice number is in the reference');
  if (signals.includes('reference')) parts.push('your invoice reference is in the statement text');
  if (signals.includes('client-name')) parts.push('the client name is in the statement text');
  if (signals.includes('near-due-date')) parts.push('it arrived around the due date');

  const sentence = parts.length > 0 ? parts.join(', ') : 'nothing beyond the amount';
  return partial
    ? `Part payment — ${sentence}.`
    : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * Score one credit against one invoice.
 *
 * Returns null when there is no case to answer at all, so the caller is not
 * handed a list of every invoice with a confidence of 0.05.
 */
export function scoreMatch(row: BankRow, invoice: MatchableInvoice): MatchProposal | null {
  // Only money coming IN can settle an invoice.
  if (row.amount <= 0) return null;
  if (invoice.outstanding <= 0) return null;

  const text = `${row.description} ${row.reference}`;
  const signals: MatchSignal[] = [];
  let confidence = 0;

  const exact = row.amount === invoice.outstanding;
  const partial = !exact && row.amount < invoice.outstanding;

  if (exact) {
    signals.push('exact-amount');
    confidence += 0.55;
  } else if (partial) {
    signals.push('partial-amount');
    confidence += 0.15;
  } else {
    // More than is owed. Could be two invoices settled together, which is a
    // judgement for a person, not for this.
    return null;
  }

  if (mentionsInvoice(text, invoice.number)) {
    signals.push('invoice-number');
    confidence += 0.35;
  }

  if (invoice.reference && squash(text).includes(squash(invoice.reference))) {
    signals.push('reference');
    confidence += 0.15;
  }

  if (mentionsClient(text, invoice.clientName)) {
    signals.push('client-name');
    confidence += 0.2;
  }

  // Paid near the due date is weak corroboration, and worth nothing on its
  // own — most invoices are paid near their due date.
  const proximity = Math.min(daysBetween(row.date, invoice.dueOn), daysBetween(row.date, invoice.issuedOn));
  if (proximity <= 14) {
    signals.push('near-due-date');
    confidence += 0.08;
  }

  /**
   * An exact amount and nothing else is NOT confident. Two invoices for the
   * same round figure — a retainer, a standard package — are exactly the case
   * where a silent mis-match happens, and the amount alone cannot tell them
   * apart.
   */
  const corroborated =
    signals.includes('invoice-number') ||
    signals.includes('reference') ||
    signals.includes('client-name');

  if (!corroborated) confidence = Math.min(confidence, 0.5);

  /**
   * A PART payment with nothing to tie it to this invoice is not a proposal
   * at all. Any credit smaller than the balance "partly matches" every larger
   * invoice, so without corroboration every coffee refund would be offered
   * against every unpaid job — noise that makes the real matches harder to
   * see and invites a careless click. An exact amount at least narrows it.
   */
  if (partial && !corroborated) return null;

  if (confidence < 0.2) return null;

  return {
    fingerprint: row.fingerprint,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    confidence: Math.min(Math.round(confidence * 100) / 100, 1),
    signals,
    amount: row.amount,
    partial,
    reason: describe(signals, partial),
  };
}

export interface RowMatches {
  row: BankRow;
  /** Best first. Empty when nothing plausible was found. */
  proposals: MatchProposal[];
}

/**
 * Propose matches for a set of credits.
 *
 * An invoice is offered against at most one credit — the best one — so a
 * single invoice cannot be proposed as settled twice in the same pass.
 * Ambiguity is surfaced rather than resolved: when two invoices score
 * equally, both are listed and neither is marked confident.
 */
export function proposeMatches(
  rows: BankRow[],
  invoices: MatchableInvoice[],
  currency: Currency,
): RowMatches[] {
  const eligible = invoices.filter((invoice) => invoice.currency === currency);

  const all: RowMatches[] = rows
    .filter((row) => row.amount > 0)
    .map((row) => {
      const proposals = eligible
        .map((invoice) => scoreMatch(row, invoice))
        .filter((p): p is MatchProposal => p !== null)
        .sort((a, b) => b.confidence - a.confidence || a.invoiceNumber.localeCompare(b.invoiceNumber));

      /**
       * Two invoices that score the same tell you the evidence does not
       * distinguish them. Saying "probably this one" there is precisely the
       * mistake worth avoiding, so both are demoted below the bulk-accept
       * threshold and the person decides.
       */
      if (proposals.length > 1 && proposals[0]!.confidence === proposals[1]!.confidence) {
        for (const proposal of proposals) {
          if (proposal.confidence === proposals[0]!.confidence) {
            proposal.confidence = Math.min(proposal.confidence, CONFIDENT - 0.01);
            proposal.reason = `${proposal.reason} Another invoice matches just as well, so this one is a guess.`;
          }
        }
      }

      return { row, proposals };
    });

  // One invoice, one proposed settlement: keep only its strongest candidate.
  const bestForInvoice = new Map<string, { confidence: number; fingerprint: string }>();
  for (const { proposals } of all) {
    for (const proposal of proposals) {
      const held = bestForInvoice.get(proposal.invoiceId);
      if (!held || proposal.confidence > held.confidence) {
        bestForInvoice.set(proposal.invoiceId, {
          confidence: proposal.confidence,
          fingerprint: proposal.fingerprint,
        });
      }
    }
  }

  for (const entry of all) {
    entry.proposals = entry.proposals.filter((proposal) => {
      const held = bestForInvoice.get(proposal.invoiceId);
      return held?.fingerprint === proposal.fingerprint;
    });
  }

  return all;
}
