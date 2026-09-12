import { describe, it, expect } from 'vitest';
import { renderTemplate, unknownTokens, escapeHtml } from '~/lib/mail/render';
import { TEMPLATE_KINDS, invoiceValues, sampleValues, variablesFor } from '~/lib/mail/variables';
import { STARTERS, startersFor, starterById } from '~/lib/mail/starters';
import { withTrackingPixel, pixelUrl, looksLikePrefetch } from '~/lib/mail/tracking';

describe('renderTemplate', () => {
  it('substitutes tokens, with or without surrounding whitespace', () => {
    const values = { 'client.name': 'Kōwhai', 'invoice.number': 'INV-0042' };
    expect(renderTemplate('Kia ora {{client.name}}, re {{ invoice.number }}.', values)).toBe(
      'Kia ora Kōwhai, re INV-0042.',
    );
  });

  it('renders an unknown token as nothing rather than leaking it', () => {
    // A client seeing the literal `{{invoice.total}}` looks like a broken
    // system; a missing figure merely looks like an oversight.
    expect(renderTemplate('Owing: {{invoice.total}}', {})).toBe('Owing: ');
  });

  it('renders null and undefined values as empty', () => {
    expect(renderTemplate('[{{a}}][{{b}}]', { a: null, b: undefined })).toBe('[][]');
  });

  it('leaves text that is not a token alone', () => {
    expect(renderTemplate('Use {braces} and {{ not a token }} here', {})).toBe(
      'Use {braces} and {{ not a token }} here',
    );
  });

  it('coerces numbers', () => {
    expect(renderTemplate('{{n}} days', { n: 7 })).toBe('7 days');
  });
});

describe('renderTemplate escaping', () => {
  const hostile = { 'client.name': '<script>alert(1)</script>' };

  it('escapes substituted values in the HTML pass', () => {
    const out = renderTemplate('<p>Kia ora {{client.name}}</p>', hostile);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes a quote that would otherwise break out of an attribute', () => {
    const out = renderTemplate('<a title="{{client.name}}">x</a>', {
      'client.name': '" onmouseover="evil()',
    });
    expect(out).toBe('<a title="&quot; onmouseover=&quot;evil()">x</a>');
  });

  it('does not escape in the plain-text pass', () => {
    // `Ben & Jerry's` must read as itself in a text/plain part, not as
    // `Ben &amp; Jerry&#39;s`.
    const out = renderTemplate('Kia ora {{client.name}}', { 'client.name': "Ben & Jerry's" }, {
      escape: false,
    });
    expect(out).toBe("Kia ora Ben & Jerry's");
  });

  it('does not escape the template author’s own markup', () => {
    expect(renderTemplate('<b>bold</b> {{x}}', { x: 'y' })).toContain('<b>bold</b>');
  });

  it('escapeHtml covers the five characters that matter', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('unknownTokens', () => {
  it('names tokens with no value, once each', () => {
    const found = unknownTokens('{{a}} {{b}} {{a}}', { a: 'ok' });
    expect(found).toEqual(['b']);
  });

  it('accepts a token whose value is empty but present', () => {
    // An invoice with no reference has an empty `invoice.reference`. That is a
    // known variable, not a typo, and must not be flagged.
    expect(unknownTokens('{{invoice.reference}}', { 'invoice.reference': '' })).toEqual([]);
  });

  it('finds nothing in a template using only catalogued variables', () => {
    const body = variablesFor('invoice')
      .map((v) => `{{${v.key}}}`)
      .join(' ');
    expect(unknownTokens(body, sampleValues('invoice'))).toEqual([]);
  });
});

describe('invoiceValues', () => {
  const base = {
    invoiceNumber: 'INV-0042',
    clientName: 'Kōwhai Coffee Roasters',
    clientEmail: 'accounts@kowhai.co.nz',
    total: 143_750,
    amountPaid: 0,
    currency: 'NZD' as const,
    issuedOn: '2026-09-01',
    dueOn: '2026-09-15',
    reference: 'PO-8891',
    daysOverdue: 0,
    viewUrl: 'https://example.test/pay/abc',
    businessName: 'JWBS Studio',
    businessEmail: 'hello@jwbsstudio.com',
    businessPhone: '',
    businessWebsite: '',
    senderName: 'Zac',
  };

  it('formats money with the currency code, matching the PDF', () => {
    const values = invoiceValues(base);
    expect(values['invoice.total']).toBe('NZ$1,437.50');
  });

  it('subtracts payments for the amount still owing', () => {
    const values = invoiceValues({ ...base, amountPaid: 43_750 });
    expect(values['invoice.amountDue']).toBe('NZ$1,000.00');
    expect(values['invoice.amountPaid']).toBe('NZ$437.50');
  });

  it('formats dates as a person would write them', () => {
    expect(invoiceValues(base)['invoice.dueOn']).toBe('15 September 2026');
  });

  it('takes the first word for a first-name greeting', () => {
    expect(invoiceValues(base)['client.firstName']).toBe('Kōwhai');
  });

  it('never reports a negative overdue count', () => {
    // An invoice due next week is not "-4 days overdue".
    expect(invoiceValues({ ...base, daysOverdue: -4 })['invoice.daysOverdue']).toBe('0');
  });

  it('falls back to the view link when card payment is off', () => {
    const values = invoiceValues(base);
    expect(values['links.pay']).toBe(base.viewUrl);
  });
});

describe('tracking pixel', () => {
  it('goes immediately before the closing body tag', () => {
    const html = withTrackingPixel('<html><body><p>Hi</p></body></html>', 'https://x.test/e/t.gif');
    expect(html).toContain('<p>Hi</p><img src="https://x.test/e/t.gif"');
    expect(html.endsWith('</body></html>')).toBe(true);
  });

  it('appends when there is no body tag', () => {
    const html = withTrackingPixel('<p>Hi</p>', 'https://x.test/e/t.gif');
    expect(html.startsWith('<p>Hi</p><img')).toBe(true);
  });

  it('uses the last closing body tag, not one quoted in the content', () => {
    const html = withTrackingPixel('<body>see &lt;/body&gt; here</body>', 'u');
    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('here'));
  });

  it('builds a URL without doubling the slash', () => {
    expect(pixelUrl('https://x.test/', 'abc')).toBe('https://x.test/e/abc.gif');
    expect(pixelUrl('https://x.test', 'abc')).toBe('https://x.test/e/abc.gif');
  });

  it('is invisible and unannounced', () => {
    const html = withTrackingPixel('<body></body>', 'u');
    expect(html).toContain('alt=""');
    expect(html).toContain('width="1"');
  });
});

describe('looksLikePrefetch', () => {
  const sentAt = '2026-09-12T10:00:00.000Z';
  const at = (seconds: number) => new Date(sentAt).getTime() + seconds * 1000;

  it('flags a hit that arrives before anyone could have read it', () => {
    expect(looksLikePrefetch(null, sentAt, at(2))).toBe(true);
  });

  it('does not flag a hit an hour later', () => {
    expect(looksLikePrefetch('Mozilla/5.0', sentAt, at(3600))).toBe(false);
  });

  it('flags known scanners whenever they arrive', () => {
    expect(looksLikePrefetch('Mozilla/5.0 (GoogleImageProxy)', sentAt, at(86_400))).toBe(true);
    expect(looksLikePrefetch('Proofpoint-URL-Scanner', sentAt, at(86_400))).toBe(true);
  });
});

describe('base templates', () => {
  it('has a unique id for every starter', () => {
    const ids = STARTERS.map((starter) => starter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers at least one starter for every kind', () => {
    for (const kind of TEMPLATE_KINDS) {
      expect(startersFor(kind).length, `no base template for ${kind}`).toBeGreaterThan(0);
    }
  });

  it('only uses variables the kinds it is offered for can resolve', () => {
    // The whole point of scoping a starter to a kind. A proposal starter shown
    // for invoices would carry `{{proposal.amount}}`, which an invoice send
    // has no value for — the client would get a gap mid-sentence.
    for (const starter of STARTERS) {
      for (const kind of starter.kinds) {
        const unknown = unknownTokens(`${starter.subject}\n${starter.html}`, sampleValues(kind));
        expect(unknown, `${starter.id} uses ${unknown.join(', ')} which ${kind} cannot fill`).toEqual(
          [],
        );
      }
    }
  });

  it('writes blocks with the markup the editor parses back', () => {
    // These four tags are a contract with the editor's parser. Mistype one and
    // the block silently degrades to a paragraph — the starter still renders,
    // it just quietly stops being a button or a section.
    for (const starter of STARTERS) {
      for (const match of starter.html.matchAll(/<section[^>]*>/g)) {
        expect(match[0], `${starter.id}: section without data-type`).toContain(
          'data-type="section"',
        );
      }
      for (const match of starter.html.matchAll(/<a\s[^>]*>/g)) {
        expect(match[0], `${starter.id}: anchor is neither a button nor a link`).toContain(
          'data-id="react-email-button"',
        );
      }
      for (const match of starter.html.matchAll(/<div[^>]*>/g)) {
        expect(match[0], `${starter.id}: bare div the editor will drop`).toMatch(
          /data-type="(two-columns|three-columns|four-columns|column|container)"/,
        );
      }
    }
  });

  it('gives every column block the columns it promises', () => {
    // A `two-columns` block with three columns inside is not a layout bug the
    // editor repairs — the schema drops the extra one on parse.
    for (const starter of STARTERS) {
      const expected =
        (starter.html.match(/data-type="two-columns"/g)?.length ?? 0) * 2 +
        (starter.html.match(/data-type="three-columns"/g)?.length ?? 0) * 3 +
        (starter.html.match(/data-type="four-columns"/g)?.length ?? 0) * 4;

      const actual = starter.html.match(/data-type="column"/g)?.length ?? 0;
      expect(actual, `${starter.id}: ${actual} columns for ${expected} column slots`).toBe(expected);
    }
  });

  it('resolves a starter by id, and nothing by a made-up one', () => {
    expect(starterById('plain')?.name).toBe('Plain letter');
    expect(starterById('no-such-starter')).toBeNull();
    expect(starterById(undefined)).toBeNull();
  });

  it('gives every starter a subject', () => {
    for (const starter of STARTERS) {
      expect(starter.subject.trim(), `${starter.id} has no subject`).not.toBe('');
    }
  });
});
