import { describe, it, expect } from 'vitest';
import {
  buildEvent,
  describeEventType,
  isNewOccurrence,
  parseDetail,
  summariseEvent,
  CLIENT_EVENT_TYPES,
  INVOICE_EVENT_TYPES,
  REPEAT_WINDOW_MINUTES,
  type InvoiceEventType,
} from '~/lib/activity/events';
import {
  identifyProxy,
  pixelResponse,
  trackingPixelUrl,
  TRANSPARENT_GIF,
} from '~/lib/activity/tracking';
import { mergeTimeline, type TimelineEntry } from '~/lib/activity/timeline';
import { invoiceEmail } from '~/lib/mail/templates';

describe('building an event row', () => {
  it('defaults the actor to the client when no user did it', () => {
    const row = buildEvent({ invoiceId: 'inv1', type: 'viewed' });
    expect(row.actor).toBe('client');
  });

  it('defaults the actor to the user when one is named', () => {
    const row = buildEvent({ invoiceId: 'inv1', userId: 'usr1', type: 'sent' });
    expect(row.actor).toBe('user');
  });

  it('honours an explicit actor over the default', () => {
    const row = buildEvent({ invoiceId: 'inv1', userId: 'usr1', type: 'paid', actor: 'system' });
    expect(row.actor).toBe('system');
  });

  it('uses a supplied id, so a pixel URL can name the row before it exists', () => {
    const row = buildEvent({ id: 'evt-fixed', invoiceId: 'inv1', type: 'sent' });
    expect(row.id).toBe('evt-fixed');
  });

  it('generates an id when none is given', () => {
    const a = buildEvent({ invoiceId: 'inv1', type: 'sent' });
    const b = buildEvent({ invoiceId: 'inv1', type: 'sent' });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toHaveLength(26);
  });

  it('serialises detail as JSON, defaulting to an empty object', () => {
    expect(buildEvent({ invoiceId: 'inv1', type: 'sent' }).detail).toBe('{}');
    expect(buildEvent({ invoiceId: 'inv1', type: 'sent', detail: { to: 'a@b.co' } }).detail).toBe(
      '{"to":"a@b.co"}',
    );
  });

  it('truncates a long user agent rather than storing it whole', () => {
    const row = buildEvent({ invoiceId: 'inv1', type: 'viewed', userAgent: 'x'.repeat(500) });
    expect(row.userAgent).toHaveLength(200);
  });

  it('stores a missing user agent as null, not an empty string', () => {
    expect(buildEvent({ invoiceId: 'inv1', type: 'viewed', userAgent: '' }).userAgent).toBeNull();
    expect(buildEvent({ invoiceId: 'inv1', type: 'viewed' }).userAgent).toBeNull();
  });

  it('writes an ISO-8601 timestamp by default', () => {
    const row = buildEvent({ invoiceId: 'inv1', type: 'sent' });
    expect(row.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('the repeat window', () => {
  const now = '2026-03-10T12:00:00.000Z';

  it('always records the first occurrence', () => {
    expect(isNewOccurrence(null, now)).toBe(true);
    expect(isNewOccurrence(undefined, now)).toBe(true);
  });

  it('suppresses a reload moments later', () => {
    expect(isNewOccurrence('2026-03-10T11:58:00.000Z', now)).toBe(false);
  });

  it('records a fresh look once the window has passed', () => {
    expect(isNewOccurrence('2026-03-10T11:29:00.000Z', now)).toBe(true);
  });

  it('treats exactly the window as a new occurrence', () => {
    const exactly = new Date(Date.parse(now) - REPEAT_WINDOW_MINUTES * 60_000).toISOString();
    expect(isNewOccurrence(exactly, now)).toBe(true);
  });

  it('honours a caller-supplied window', () => {
    expect(isNewOccurrence('2026-03-10T11:55:00.000Z', now, 2)).toBe(true);
    expect(isNewOccurrence('2026-03-10T11:55:00.000Z', now, 10)).toBe(false);
  });

  // A stuck window would silently stop logging, which is the one failure mode
  // that looks exactly like a client who never came back.
  it('does not lock shut when the last event is somehow in the future', () => {
    expect(isNewOccurrence('2026-03-10T13:00:00.000Z', now)).toBe(true);
  });

  it('records rather than drops when a timestamp is unparseable', () => {
    expect(isNewOccurrence('not a date', now)).toBe(true);
  });
});

describe('event descriptions', () => {
  it('has a label and tone for every type in the schema', () => {
    for (const type of INVOICE_EVENT_TYPES) {
      const described = describeEventType(type);
      expect(described.label).toBeTruthy();
      expect(described.label).not.toBe(type);
      expect(described.tone).toBeTruthy();
    }
  });

  it('attributes exactly the client-side types to the client', () => {
    expect(CLIENT_EVENT_TYPES).toEqual([
      'email-opened',
      'viewed',
      'pdf-downloaded',
      'payment-started',
    ]);
  });

  it('marks a failed send as a problem', () => {
    expect(describeEventType('send-failed').tone).toBe('problem');
  });

  it('falls back to the raw type for something unknown', () => {
    expect(describeEventType('invented' as InvoiceEventType).label).toBe('invented');
  });
});

describe('event summaries', () => {
  it('names the recipient of a send', () => {
    expect(summariseEvent('sent', { to: 'accounts@kowhai.co.nz' })).toBe(
      'To accounts@kowhai.co.nz',
    );
  });

  it('gives the recipient and the reason for a failure', () => {
    expect(summariseEvent('send-failed', { to: 'a@b.co', error: 'domain not verified' })).toBe(
      'To a@b.co — domain not verified',
    );
  });

  it('formats a payment with its own currency, not the default', () => {
    const aud = summariseEvent('payment-recorded', {
      amount: 125_000, currency: 'AUD', method: 'stripe',
    });
    const nzd = summariseEvent('payment-recorded', {
      amount: 125_000, currency: 'NZD', method: 'stripe',
    });
    expect(aud).toBe('AU$1,250.00 · stripe');
    expect(aud).not.toBe(nzd);
  });

  it('calls out the first view of the link, and stays quiet on the rest', () => {
    expect(summariseEvent('viewed', { first: true })).toMatch(/first time/i);
    expect(summariseEvent('viewed', { first: false })).toBe('');
  });

  it('says an open came through a proxy when it did', () => {
    expect(summariseEvent('email-opened', { proxy: 'Gmail image proxy' })).toMatch(/Gmail image proxy/);
  });

  it('hedges an untraced open rather than calling it a read', () => {
    expect(summariseEvent('email-opened', {})).toMatch(/weaker evidence/i);
  });

  it('survives a detail blob with the wrong types in it', () => {
    expect(summariseEvent('payment-recorded', { amount: 'lots', method: 42 })).toBe('');
    expect(summariseEvent('created', { total: Number.NaN })).toBe('');
  });
});

describe('parsing a stored detail blob', () => {
  it('reads back what was written', () => {
    expect(parseDetail('{"to":"a@b.co"}')).toEqual({ to: 'a@b.co' });
  });

  it('yields an empty object for anything unusable', () => {
    expect(parseDetail(null)).toEqual({});
    expect(parseDetail('')).toEqual({});
    expect(parseDetail('not json')).toEqual({});
    expect(parseDetail('[1,2]')).toEqual([1, 2]); // An array is still an object.
    expect(parseDetail('null')).toEqual({});
    expect(parseDetail('42')).toEqual({});
  });
});

describe('the tracking pixel', () => {
  it('is a valid 1x1 GIF', () => {
    expect(TRANSPARENT_GIF.byteLength).toBe(42);
    expect(String.fromCharCode(...TRANSPARENT_GIF.subarray(0, 6))).toBe('GIF89a');
    // Width and height, little-endian, at bytes 6-9.
    expect(TRANSPARENT_GIF[6]! | (TRANSPARENT_GIF[7]! << 8)).toBe(1);
    expect(TRANSPARENT_GIF[8]! | (TRANSPARENT_GIF[9]! << 8)).toBe(1);
  });

  it('builds a URL from the public token and the send event', () => {
    expect(trackingPixelUrl('https://billing.example.com', 'tok-123', 'evt-456')).toBe(
      'https://billing.example.com/t/tok-123/evt-456.gif',
    );
  });

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(trackingPixelUrl('https://billing.example.com/', 'tok', 'evt')).toBe(
      'https://billing.example.com/t/tok/evt.gif',
    );
  });

  it('escapes a token that would otherwise change the path', () => {
    expect(trackingPixelUrl('https://x.test', 'a/b', 'evt')).toBe('https://x.test/t/a%2Fb/evt.gif');
  });

  it('refuses to be cached, or the second open would never arrive', () => {
    const response = pixelResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('recognises the proxies that fetch images on a recipient behalf', () => {
    expect(identifyProxy('Mozilla/5.0 (compatible; GoogleImageProxy)')).toBe('Gmail image proxy');
    expect(identifyProxy('Mimecast Scanner')).toBe('mail security scanner');
    expect(identifyProxy('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBeNull();
    expect(identifyProxy(null)).toBeNull();
  });
});

describe('the email carries the pixel only when asked', () => {
  const data = {
    invoiceNumber: 'INV-0042',
    clientName: 'Kōwhai Coffee Roasters',
    businessName: 'JWBS Studio',
    senderName: 'Zac',
    total: 250_000,
    currency: 'NZD' as const,
    dueOn: '2026-04-01',
    viewUrl: 'https://billing.example.com/pay/tok',
  };

  it('embeds the pixel when a URL is given', () => {
    const mail = invoiceEmail({ ...data, trackingPixelUrl: 'https://billing.example.com/t/tok/e.gif' });
    expect(mail.html).toContain('src="https://billing.example.com/t/tok/e.gif"');
    expect(mail.html).toContain('width="1"');
  });

  it('sends no remote image at all when tracking is off', () => {
    const mail = invoiceEmail(data);
    expect(mail.html).not.toContain('<img');
  });

  it('never puts the tracking URL in the plain-text part', () => {
    const mail = invoiceEmail({ ...data, trackingPixelUrl: 'https://billing.example.com/t/tok/e.gif' });
    expect(mail.text).not.toContain('/t/tok/');
  });
});

describe('merging the two logs into one timeline', () => {
  const entry = (id: string, at: string, source: TimelineEntry['source']): TimelineEntry => ({
    id,
    at,
    label: id,
    note: '',
    tone: 'neutral',
    actor: 'user',
    source,
    kind: 'note',
    invoiceId: null,
    invoiceNumber: null,
    clientId: null,
  });

  it('interleaves both sources newest first', () => {
    const merged = mergeTimeline(
      [entry('a', '2026-03-01T10:00:00Z', 'invoice'), entry('c', '2026-03-03T10:00:00Z', 'invoice')],
      [entry('b', '2026-03-02T10:00:00Z', 'communication')],
    );
    expect(merged.map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('breaks a tie deterministically rather than shuffling', () => {
    const at = '2026-03-01T10:00:00Z';
    const first = mergeTimeline([entry('a', at, 'invoice'), entry('b', at, 'communication')]);
    const second = mergeTimeline([entry('b', at, 'communication'), entry('a', at, 'invoice')]);
    expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
  });

  it('handles no entries at all', () => {
    expect(mergeTimeline([], [])).toEqual([]);
  });
});
