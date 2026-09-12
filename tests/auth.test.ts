import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeNext } from '~/lib/auth/redirect';
import { magicLinkUrl, LINK_TTL_MINUTES } from '~/lib/auth/magic-link';
import { magicLinkEmail } from '~/lib/mail/templates';
import { logAuth, fingerprint } from '~/lib/auth/log';
import {
  sessionCookieName,
  sessionCookieOptions,
  isSecureOrigin,
  SESSION_COOKIE,
  SESSION_COOKIE_INSECURE,
} from '~/lib/auth/session';

describe('safeNext', () => {
  it('keeps a same-origin path', () => {
    expect(safeNext('/invoices/new')).toBe('/invoices/new');
    expect(safeNext('/tax?year=2026')).toBe('/tax?year=2026');
  });

  it('refuses anything that is not a path', () => {
    expect(safeNext('https://evil.example/steal')).toBe('/');
    expect(safeNext('invoices')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext(42)).toBe('/');
  });

  it('refuses protocol-relative URLs, which look like paths but are not', () => {
    expect(safeNext('//evil.example/steal')).toBe('/');
    expect(safeNext('/\\evil.example/steal')).toBe('/');
  });

  it('strips control characters that could break the Location header', () => {
    expect(safeNext('/invoices\r\nSet-Cookie: x=1')).toBe('/');
  });

  it('never sends a signed-in user back to a page that bounces them out', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/login?error=invalid')).toBe('/');
    expect(safeNext('/api/auth/logout')).toBe('/');
  });
});

describe('session cookie naming', () => {
  const https = new URL('https://billing.jwbsstudio.com/login');
  const http = new URL('http://localhost:8787/login');

  it('uses the __Host- prefixed name on https', () => {
    expect(isSecureOrigin(https)).toBe(true);
    expect(sessionCookieName(https)).toBe(SESSION_COOKIE);
    expect(sessionCookieOptions(new Date(), https).secure).toBe(true);
  });

  it('falls back to an unprefixed, non-Secure cookie on http', () => {
    // A __Host- cookie cannot be set over plain http. Safari drops it
    // outright, which presents as "the password did not work".
    expect(isSecureOrigin(http)).toBe(false);
    expect(sessionCookieName(http)).toBe(SESSION_COOKIE_INSECURE);
    expect(sessionCookieName(http).startsWith('__Host-')).toBe(false);
    expect(sessionCookieOptions(new Date(), http).secure).toBe(false);
  });

  it('keeps the cookie HttpOnly, lax and path-scoped either way', () => {
    for (const url of [https, http]) {
      const options = sessionCookieOptions(new Date('2026-10-01T00:00:00Z'), url);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('lax');
      expect(options.path).toBe('/');
    }
  });
});

describe('magicLinkUrl', () => {
  it('puts the token in the path and percent-encodes it', () => {
    const url = magicLinkUrl('https://billing.jwbsstudio.com', 'abc-def_123', '/');
    expect(url).toBe('https://billing.jwbsstudio.com/login/link/abc-def_123');
  });

  it('carries a next path through as a query parameter', () => {
    const url = magicLinkUrl('https://billing.jwbsstudio.com', 'tok', '/invoices/new');
    expect(url).toBe('https://billing.jwbsstudio.com/login/link/tok?next=%2Finvoices%2Fnew');
  });

  it('omits next when it is just the dashboard', () => {
    expect(magicLinkUrl('https://x.test', 'tok', '/')).not.toContain('next');
  });

  it('works against a local dev origin', () => {
    expect(magicLinkUrl('http://localhost:8787', 'tok', '/')).toBe(
      'http://localhost:8787/login/link/tok',
    );
  });
});

describe('magicLinkEmail', () => {
  const data = {
    name: 'Zac',
    appName: 'JWBS Studio Billing',
    url: 'https://billing.jwbsstudio.com/login/link/tok123',
    expiresMinutes: LINK_TTL_MINUTES,
    requestedIp: '203.0.113.7',
  };

  it('carries the link in both the text and html parts', () => {
    const mail = magicLinkEmail(data);
    expect(mail.text).toContain(data.url);
    expect(mail.html).toContain(data.url);
  });

  it('states the expiry, so an old mail is recognisably stale', () => {
    const mail = magicLinkEmail(data);
    expect(mail.text).toContain(`${LINK_TTL_MINUTES} minutes`);
    expect(mail.subject).toBe('Your sign-in link for JWBS Studio Billing');
  });

  it('names where the link was asked for', () => {
    expect(magicLinkEmail(data).text).toContain('203.0.113.7');
    expect(magicLinkEmail({ ...data, requestedIp: null }).text).not.toContain('from ');
  });

  it('escapes a name so it cannot inject markup into the html part', () => {
    const mail = magicLinkEmail({ ...data, name: '<script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>alert(1)</script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});

describe('auth log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one parseable JSON line behind an [auth] prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logAuth({ action: 'auth.login', outcome: 'ok', userId: 'u1', email: 'z@example.com' });

    const text = spy.mock.calls[0]![0] as string;
    expect(text.startsWith('[auth] ')).toBe(true);
    const parsed = JSON.parse(text.slice('[auth] '.length));
    expect(parsed).toMatchObject({ action: 'auth.login', outcome: 'ok', userId: 'u1' });
    expect(typeof parsed.at).toBe('string');
  });

  it('routes denials to warn and errors to error, so they surface as such', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    logAuth({ action: 'auth.login', outcome: 'denied', reason: 'bad-password' });
    logAuth({ action: 'auth.env.no-db', outcome: 'error', reason: 'no-db-binding' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('truncates a long user agent rather than filling the log with it', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logAuth({ action: 'auth.login', outcome: 'ok', userAgent: 'x'.repeat(500) });

    const parsed = JSON.parse((spy.mock.calls[0]![0] as string).slice('[auth] '.length));
    expect(parsed.userAgent).toHaveLength(200);
  });

  it('fingerprints a token hash short enough to be useless on its own', () => {
    const hash = 'a'.repeat(64);
    expect(fingerprint(hash)).toBe('aaaaaaaa');
    expect(fingerprint(hash)).toHaveLength(8);
  });
});
