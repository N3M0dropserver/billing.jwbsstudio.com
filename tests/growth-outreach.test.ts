import { describe, expect, it } from 'vitest';
import { renderOutreachText, sendOutreach } from '~/lib/growth/proposal';
import { pickEmail, readStructuredData } from '~/lib/growth/enrich';

const MESSAGE = {
  to: 'hello@wells.test',
  toName: 'Wells Coffee',
  subject: 'A concept for Wells Coffee',
  body: 'I noticed your site has no mobile viewport.',
  demoUrl: 'https://wells-coffee.demo.example',
  proposalUrl: 'https://billing.example/proposal/abc',
  senderName: 'Zac',
  signature: '— Zac, JWBS Studio',
  replyTo: 'zac@example.com',
};

describe('the outreach email', () => {
  const text = renderOutreachText(MESSAGE);

  it('is plain text with both links on their own lines', () => {
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toContain('\nThe concept: https://wells-coffee.demo.example');
    expect(text).toContain('\nA bit more on the thinking: https://billing.example/proposal/abc');
  });

  it('always ends by offering to take it down', () => {
    // A site built for someone who did not ask must come with a way out, in
    // the email itself rather than only on the page.
    expect(text).toContain('I built this without being asked');
    expect(text).toContain('take it down');
  });

  it('signs as the person, not the software', () => {
    expect(text).toContain('— Zac, JWBS Studio');
  });
});

describe('the daily cap', () => {
  const env = { MAIL_PROVIDER: 'none' } as unknown as Env;

  it('stops an unattended send once the cap is spent', async () => {
    const result = await sendOutreach(env, MESSAGE, {
      sentToday: 10,
      dailyCap: 10,
      initiatedByUser: false,
    });
    expect(result).toMatchObject({ ok: false, capped: true });
  });

  it('treats a cap of zero as switching unattended sending off', async () => {
    const result = await sendOutreach(env, MESSAGE, {
      sentToday: 0,
      dailyCap: 0,
      initiatedByUser: false,
    });
    expect(result).toMatchObject({ ok: false, capped: true });
  });

  it('does not cap a person pressing send', async () => {
    const result = await sendOutreach(env, MESSAGE, {
      sentToday: 999,
      dailyCap: 0,
      initiatedByUser: true,
    });
    // It still fails — mail is disabled in this env — but not because of the
    // cap, which is the distinction that matters.
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('capped', true);
  });

  it('refuses an address that is not an address, before any send', async () => {
    for (const to of ['', 'not-an-email', 'a@b']) {
      const result = await sendOutreach(env, { ...MESSAGE, to }, {
        sentToday: 0,
        dailyCap: 10,
        initiatedByUser: true,
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toContain('email address');
    }
  });
});

describe('contact picking', () => {
  it('prefers a named mailbox over a role one', () => {
    expect(pickEmail(['info@wells.test', 'jane@wells.test'], 'wells.test')).toBe('jane@wells.test');
  });

  it('prefers an address on their own domain', () => {
    expect(pickEmail(['someone@gmail.com', 'info@wells.test'], 'wells.test')).toBe('info@wells.test');
  });

  it('takes what it can get', () => {
    expect(pickEmail(['info@wells.test'], 'wells.test')).toBe('info@wells.test');
    expect(pickEmail([], 'wells.test')).toBe('');
  });
});

describe('structured data', () => {
  it('reads ratings, hours and contacts out of JSON-LD', () => {
    const facts = readStructuredData([
      {
        '@type': 'LocalBusiness',
        email: 'mailto:Hello@Wells.test',
        telephone: '04 555 0198',
        openingHours: ['Mo-Fr 07:00-15:00', 'Sa 08:00-13:00'],
        aggregateRating: { ratingValue: '4.7', reviewCount: 62 },
      },
    ]);

    expect(facts.rating).toBe(4.7);
    expect(facts.reviewCount).toBe(62);
    expect(facts.email).toBe('hello@wells.test');
    expect(facts.openingHours).toHaveLength(2);
  });

  it('walks an @graph', () => {
    const facts = readStructuredData([
      { '@graph': [{ '@type': 'Person', name: 'Jane Wells', jobTitle: 'Owner' }] },
    ]);
    expect(facts.contactName).toBe('Jane Wells');
    expect(facts.contactRole).toBe('Owner');
  });

  it('collects review quotes', () => {
    const facts = readStructuredData([
      [{ '@type': 'Review', reviewBody: 'Best flat white in town.' }],
    ]);
    expect(facts.reviewQuotes).toEqual(['Best flat white in town.']);
  });

  it('does not fall over on rubbish', () => {
    expect(() => readStructuredData([null, 3, 'x', [], {}])).not.toThrow();
  });
});
