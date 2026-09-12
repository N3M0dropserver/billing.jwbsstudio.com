/**
 * Post-sign-in redirect targets.
 *
 * `next` reaches us from a query string and from an emailed link, so it is
 * attacker-controlled in principle. Anything other than a same-origin
 * absolute path is an open redirect waiting to be pasted into a phishing
 * mail, so we accept only paths and fall back to the dashboard.
 */

/** Paths that would bounce a freshly signed-in user straight back out. */
const NEVER_NEXT = ['/login', '/api/'];

/** Control characters, which could smuggle a header break into a Location. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function safeNext(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '/';

  // Must be an absolute path on this origin. `//evil.example` is a
  // protocol-relative URL, not a path, and some browsers normalise the
  // backslash form to the same thing — reject both.
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';

  if (CONTROL_CHARS.test(raw)) return '/';

  if (NEVER_NEXT.some((prefix) => raw === prefix || raw.startsWith(prefix))) return '/';

  return raw;
}
