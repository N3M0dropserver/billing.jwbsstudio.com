import { describe, it, expect } from 'vitest';
import { quoteEditability, QUOTE_REFUSAL_MESSAGE, hasLapsed } from '~/lib/quotes/service';
import { quoteEmail } from '~/lib/mail/templates';

const $ = (d: number) => Math.round(d * 100);

describe('quoteEditability', () => {
  it('allows a draft or a sent quote to be corrected', () => {
    expect(quoteEditability({ status: 'draft', convertedInvoiceId: null }).canEdit).toBe(true);
    expect(quoteEditability({ status: 'sent', convertedInvoiceId: null }).canEdit).toBe(true);
    expect(quoteEditability({ status: 'viewed', convertedInvoiceId: null }).canEdit).toBe(true);
  });

  it('refuses once the client has accepted', () => {
    // Changing the figures now would change what they agreed to.
    expect(quoteEditability({ status: 'accepted', convertedInvoiceId: null })).toEqual({
      canEdit: false,
      reason: 'accepted',
    });
  });

  it('refuses once it has become an invoice, whatever its status says', () => {
    expect(quoteEditability({ status: 'sent', convertedInvoiceId: 'inv1' })).toEqual({
      canEdit: false,
      reason: 'converted',
    });
  });

  it('refuses a declined quote', () => {
    expect(quoteEditability({ status: 'declined', convertedInvoiceId: null }).canEdit).toBe(false);
  });

  it('has a message for every refusal', () => {
    for (const reason of ['accepted', 'converted', 'declined'] as const) {
      expect(QUOTE_REFUSAL_MESSAGE[reason]).toBeTruthy();
    }
  });
});

describe('hasLapsed', () => {
  it('lapses after the expiry date', () => {
    expect(hasLapsed({ expiresOn: '2026-09-01', status: 'sent' }, '2026-09-02')).toBe(true);
    expect(hasLapsed({ expiresOn: '2026-09-01', status: 'sent' }, '2026-09-01')).toBe(false);
  });

  it('does not lapse a quote that has already been answered', () => {
    // An accepted quote stays accepted; the agreement does not expire because
    // the invoice took a fortnight to raise.
    expect(hasLapsed({ expiresOn: '2020-01-01', status: 'accepted' }, '2026-09-02')).toBe(false);
    expect(hasLapsed({ expiresOn: '2020-01-01', status: 'declined' }, '2026-09-02')).toBe(false);
  });

  it('never lapses a quote with no expiry', () => {
    expect(hasLapsed({ expiresOn: null, status: 'sent' }, '2030-01-01')).toBe(false);
  });
});

describe('quoteEmail', () => {
  const data = {
    quoteNumber: 'QUO-0007',
    title: 'Brand identity',
    clientName: 'Kowhai Studio',
    businessName: 'JWBS Studio',
    senderName: 'Zac',
    total: $(4_600),
    currency: 'NZD' as const,
    expiresOn: '2026-10-13',
    viewUrl: 'https://billing.example/proposal/abc',
  };

  it('reads as a quote, not a demand for money', () => {
    // A quote that reads like an invoice gets paid by mistake, which is a
    // worse problem than one that gets ignored.
    const mail = quoteEmail(data);
    expect(mail.subject).toMatch(/^Quote QUO-0007/);
    expect(mail.text).not.toMatch(/bank details/i);
    expect(mail.text).toMatch(/nothing is payable/i);
  });

  it('states how long it holds', () => {
    expect(quoteEmail(data).text).toMatch(/Holds until/);
  });

  it('copes with no expiry date', () => {
    const mail = quoteEmail({ ...data, expiresOn: null });
    expect(mail.text).toContain('QUO-0007');
    expect(mail.html).not.toContain('Holds until');
  });

  it('escapes a client name that contains markup', () => {
    const mail = quoteEmail({ ...data, clientName: '<script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});
