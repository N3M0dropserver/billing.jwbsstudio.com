/**
 * Publishing a demo to a subdomain.
 *
 * Files go to R2 under `demos/<host>/` and this same Worker serves them when
 * a request arrives on a host it recognises. That means a demo is live the
 * instant it is generated, with no deploy step and nothing to wait for —
 * which is what a proposal email needs.
 *
 * DNS is the only part that needs arranging once, up front. A wildcard
 * record plus a matching Worker route covers every demo forever:
 *
 *     *.demo.jwbsstudio.com   CNAME   billing.jwbsstudio.com   (proxied)
 *     route: *.demo.jwbsstudio.com/*  →  this Worker
 *
 * With that in place `createDnsRecord` is never needed. It exists for the
 * case where you would rather create each record explicitly — set
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID and it is used automatically.
 *
 * ## Why the host is a pattern rather than a parent domain
 *
 * `wells-coffee.demo.jwbsstudio.com` is two labels below the zone apex, and
 * Cloudflare's free Universal SSL covers only one. The certificate is the part
 * that catches people out: the DNS record and the route can both be right and
 * the browser still refuses the connection.
 *
 * Putting demos one label deep fixes that for nothing, but `*.jwbsstudio.com`
 * as a *route* would swallow `www` and everything else on the zone. A
 * hyphenated label is both: `wells-coffee-demo.jwbsstudio.com` is one label
 * deep, so Universal SSL covers it, and `*-demo.jwbsstudio.com/*` as a route
 * cannot match `www`.
 *
 * So the setting is a pattern. `*` is where the business's label goes, and it
 * is written exactly as the Worker route is written:
 *
 *     demo.jwbsstudio.com     →  wells-coffee.demo.jwbsstudio.com
 *     *-demo.jwbsstudio.com   →  wells-coffee-demo.jwbsstudio.com
 *
 * The one thing a hyphenated pattern cannot do is be a DNS record. A DNS
 * wildcard is a whole label — `*.jwbsstudio.com` is valid, `*-demo.
 * jwbsstudio.com` is not, and would be stored as a literal name that matches
 * nothing. See `demoDnsRecord`.
 */

import { contentTypeFor, demoPrefixFor, demoSourcePrefix, putObject } from './storage';
import type { GeneratedFile } from './render';
import { describeError } from '../errors';

/** Words that must not become a demo host on a domain we also use ourselves. */
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2',
  'billing', 'invoice', 'invoices', 'pay', 'demo', 'demos', 'staging', 'dev',
  'test', 'cdn', 'assets', 'static', 'files', 'status', 'blog', 'shop',
  'login', 'auth', 'account', 'support', 'help', 'docs', 'proposal',
]);

/**
 * A business name to a subdomain label.
 *
 * Strips the legal suffix — nobody wants `wells-coffee-roasters-limited` —
 * and produces something short enough to read out over the phone.
 */
export function slugifyBusiness(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(pty|ltd|limited|inc|incorporated|llc|co|company|group|holdings|nz|australia)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  const trimmed = cleaned.split('-').filter(Boolean).slice(0, 4).join('-').slice(0, 50);
  // A label cannot start or end with a hyphen, or be empty.
  const label = trimmed.replace(/^-+|-+$/g, '');
  return label || 'demo';
}

export function isReservedLabel(label: string): boolean {
  return RESERVED.has(label);
}

/**
 * Find a free label, appending `-2`, `-3`… until one is.
 *
 * `taken` answers whether a host is already in use; the caller supplies it
 * so this stays a pure function over the database rather than importing it.
 */
export async function allocateSubdomain(
  businessName: string,
  demoHost: string,
  taken: (host: string) => Promise<boolean>,
): Promise<{ label: string; host: string }> {
  const base = slugifyBusiness(businessName);

  /**
   * A reserved label only collides when the demo's label stands on its own.
   * Under a suffix pattern it cannot: `www-demo` is not `www`, so there is
   * nothing to steer around.
   */
  const standsAlone = demoHostPattern(demoHost).split('.')[0] === '*';
  const candidates = isReservedLabel(base) && standsAlone ? [`${base}-studio`] : [base];

  for (let suffix = 2; suffix <= 40; suffix++) candidates.push(`${base}-${suffix}`);

  for (const label of candidates) {
    const host = demoHostFor(label, demoHost);
    if (!(await taken(host))) return { label, host };
  }

  // Forty collisions on one name is not a naming problem any more.
  const label = `${base}-${Math.random().toString(36).slice(2, 7)}`;
  return { label, host: demoHostFor(label, demoHost) };
}

/* ------------------------------------------------------------------ */
/* Where a demo host comes from                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalise whatever is in the setting into a pattern containing exactly one
 * `*`, which is where the business's label goes.
 *
 * A value with no `*` is the old form — a parent domain that labels are
 * prefixed onto — and is read as `*.<value>` so both spellings describe the
 * same thing and nothing that was already configured changes meaning.
 */
export function demoHostPattern(setting: string): string {
  const clean = setting.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) return '';
  return clean.includes('*') ? clean : `*.${clean}`;
}

/**
 * Validate a demo host setting, returning '' when it is not usable.
 *
 * `*` is permitted in the first label only, and only once: it is where the
 * business's label goes. This decides what hostnames the app will generate,
 * publish under and ask Cloudflare to create records for, so it is strict —
 * a setting that is merely *nearly* a hostname produces demos nobody can
 * reach, and the failure shows up much later than the typo.
 */
export function cleanDemoHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return '';

  const [first, ...rest] = host.split('.');
  // A bare label is not a host to put demos under; it would make the demo the
  // apex of somebody's zone.
  if (rest.length === 0) return '';
  if ((first!.match(/\*/g) ?? []).length > 1) return '';

  /**
   * The label the business's name goes into. It may be the whole label (`*`),
   * or fused to a fixed part on either side (`*-demo`, `demo-*`) — the second
   * form is the one that keeps a demo a single label deep while staying
   * impossible to confuse with `www`.
   */
  const plain = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
  const wildcardLabel = new RegExp(`^(\\*|\\*-${plain}|${plain}-\\*|${plain})$`);
  const plainLabel = new RegExp(`^${plain}$`);

  if (!wildcardLabel.test(first!)) return '';
  if (!rest.every((part) => plainLabel.test(part))) return '';

  return host;
}

/** The host one demo is served at. */
export function demoHostFor(label: string, setting: string): string {
  const pattern = demoHostPattern(setting);
  if (!pattern) return label.toLowerCase();
  // Only the first `*` is a placeholder; a second one is a typo, not a second
  // slot, and leaving it in the host makes that obvious rather than silent.
  return pattern.replace('*', label).toLowerCase();
}

/** The Worker route that has to exist for the pattern to be served. */
export function demoRoute(setting: string): string {
  const pattern = demoHostPattern(setting);
  return pattern ? `${pattern}/*` : '';
}

/**
 * The DNS record that makes the pattern resolve.
 *
 * A DNS wildcard is a whole label, so `*-demo.example.com` cannot be a record
 * — it would be stored as a literal name matching nothing. The wildcard that
 * *does* cover it is one at the level above, which is why this returns
 * something broader than the route for a suffix pattern.
 *
 * `exact` says whether the record matches the pattern or merely contains it.
 * When it does not, the record catches names the route will not serve, and the
 * alternative is a record per demo — which is what `createDnsRecord` is for.
 */
export function demoDnsRecord(setting: string): { name: string; exact: boolean } {
  const pattern = demoHostPattern(setting);
  if (!pattern) return { name: '', exact: false };

  const [first, ...rest] = pattern.split('.');
  if (first === '*') return { name: pattern, exact: true };

  // A `*` inside a label: the nearest valid wildcard is the parent.
  return { name: rest.length ? `*.${rest.join('.')}` : pattern, exact: false };
}

export interface PublishResult {
  host: string;
  prefix: string;
  sourcePrefix: string;
  fileCount: number;
  bytes: number;
}

export async function publishDemo(
  bucket: R2Bucket,
  host: string,
  files: GeneratedFile[],
  source: GeneratedFile[],
  images: Array<{ path: string; body: ArrayBuffer; contentType: string }> = [],
): Promise<PublishResult> {
  const prefix = demoPrefixFor(host);
  const sourceRoot = demoSourcePrefix(prefix);
  let bytes = 0;
  let fileCount = 0;

  for (const file of files) {
    const stored = await putObject(bucket, `${prefix}/${file.path}`, file.content, file.contentType);
    bytes += stored.bytes;
    fileCount++;
  }

  for (const image of images) {
    const stored = await putObject(bucket, `${prefix}/${image.path}`, image.body, image.contentType);
    bytes += stored.bytes;
    fileCount++;
    // The project export references the same images, so they ship with it.
    await putObject(bucket, `${sourceRoot}/public/${image.path}`, image.body, image.contentType);
  }

  for (const file of source) {
    await putObject(bucket, `${sourceRoot}/${file.path}`, file.content, file.contentType);
    fileCount++;
  }

  return { host, prefix, sourcePrefix: sourceRoot, fileCount, bytes };
}

/* ------------------------------------------------------------------ */
/* Where a demo can be reached                                         */
/* ------------------------------------------------------------------ */

/**
 * The path a demo is always reachable at, on the app's own origin.
 *
 * Wildcard DNS and a Worker route are a manual setup step that is easy to
 * put off and easy to get wrong, and until they are done a subdomain link
 * simply does not resolve. That was the whole of the "generated sites are not
 * hosting" problem: the files were there and the link was unreachable.
 *
 * This mount needs no DNS at all. It is the same bytes from the same bucket,
 * served on a host that definitely exists.
 */
export function demoPathUrl(appUrl: string, host: string): string {
  return `${appUrl.replace(/\/+$/, '')}/d/${encodeURIComponent(host.toLowerCase())}/`;
}

export function demoSubdomainUrl(host: string): string {
  return `https://${host.toLowerCase()}/`;
}

/**
 * The URL to put in front of a prospect.
 *
 * The subdomain reads better and is what the feature is for — but only once
 * it has been seen to resolve. A proposal email containing a link that does
 * not load is worse than one with an ugly link that does.
 */
export function demoPublicUrl(appUrl: string, host: string, wildcardVerified: boolean): string {
  return wildcardVerified ? demoSubdomainUrl(host) : demoPathUrl(appUrl, host);
}

/**
 * Strip a `/d/<host>/` prefix off a request path.
 *
 * Returns the host and the remaining path, or null when this is not a demo
 * mount request.
 */
export function parseDemoPath(pathname: string): { host: string; rest: string } | null {
  const match = pathname.match(/^\/d\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  let host: string;
  try {
    host = decodeURIComponent(match[1]!).toLowerCase();
  } catch {
    return null;
  }

  // A host is a host. Anything with a slash or a traversal segment in it is
  // an attempt to reach outside the demo prefix.
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return null;

  return { host, rest: match[2] ?? '/' };
}

/**
 * Does the wildcard actually resolve?
 *
 * Fetches a demo host from the Worker and reports what came back. A Worker
 * calling its own zone is an ordinary subrequest; when the route is missing
 * it fails or returns the app's own 404 instead of the demo, and either is a
 * conclusive answer.
 */
export async function checkDemoHosting(
  host: string,
  /** The configured pattern, so a failure can name the record that is missing. */
  setting = '',
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(demoSubdomainUrl(host), {
      headers: { 'user-agent': 'JWBSStudioGrowth/1.0 (hosting self-check)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { ok: false, detail: `${host} answered ${response.status}.` };
    }

    const body = await response.text();
    // The ribbon is on every generated demo and on nothing else we serve, so
    // it is the cheapest proof that the demo — not the app — answered.
    if (!body.includes('unsolicited concept')) {
      return {
        ok: false,
        detail: `${host} answered, but with something other than the demo. The Worker route is probably missing.`,
      };
    }

    return { ok: true, detail: `${host} served the demo.` };
  } catch (error) {
    const record = demoDnsRecord(setting || host.split('.').slice(1).join('.'));
    return {
      ok: false,
      detail:
        `${host} could not be reached (${error}). Check three things, in this order: ` +
        `a proxied DNS record covering it (${record.name}), a Worker route for ` +
        `${demoRoute(setting) || 'the demo pattern'}, and a certificate that covers ` +
        `${host} — Universal SSL stops one label below the zone apex, and a name deeper ` +
        `than that fails here even when the record and the route are both correct.`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Serving                                                             */
/* ------------------------------------------------------------------ */

/** Map a request path onto a key, the way a static host would. */
export function demoObjectKey(host: string, pathname: string): string {
  const prefix = demoPrefixFor(host);
  let path = decodeURIComponent(pathname).replace(/^\/+/, '');

  // No traversal out of the host's own prefix.
  if (path.split('/').some((segment) => segment === '..')) return `${prefix}/index.html`;

  if (path === '' || path.endsWith('/')) path += 'index.html';
  else if (!path.split('/').pop()!.includes('.')) path += '/index.html';

  return `${prefix}/${path}`;
}

/**
 * Serve a demo out of R2.
 *
 * Returns null when the host is not one of ours, so the caller can fall
 * through to the app itself.
 */
export async function serveDemo(
  bucket: R2Bucket,
  host: string,
  url: URL,
  request: Request,
): Promise<Response | null> {
  const key = demoObjectKey(host, url.pathname);

  const object = await bucket.get(key, {
    onlyIf: request.headers.get('if-none-match')
      ? { etagDoesNotMatch: request.headers.get('if-none-match')! }
      : undefined,
  });

  if (!object) {
    // A 304 comes back as an object with no body rather than a miss, so
    // check for the missing body before deciding this is a 404.
    const head = await bucket.head(key);
    if (head) {
      return new Response(null, {
        status: 304,
        headers: { etag: head.httpEtag, 'cache-control': 'public, max-age=60' },
      });
    }

    const fallback = await bucket.get(`${demoPrefixFor(host)}/index.html`);
    if (!fallback) return null;

    return new Response(fallback.body, {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  }

  const headers = new Headers({
    'content-type': object.httpMetadata?.contentType ?? contentTypeFor(key),
    etag: object.httpEtag,
    'cache-control': key.endsWith('.html') ? 'public, max-age=60' : 'public, max-age=3600',
    // These are concepts the business has not seen. They stay out of search.
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    // The demo is static and serves no script of its own; say so.
    'content-security-policy':
      "default-src 'none'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });

  return new Response(object.body, { headers });
}

/* ------------------------------------------------------------------ */
/* DNS                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create a proxied CNAME for one demo host.
 *
 * Only needed when you are not using a wildcard record. Returns the record
 * id, or an error string — never throws, because a demo that is serving
 * fine on a wildcard should not fail its stage over a DNS call nobody
 * needed.
 */
export async function createDnsRecord(
  apiToken: string,
  zoneId: string,
  host: string,
  target: string,
): Promise<{ ok: true; recordId: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: host,
          content: target,
          proxied: true,
          comment: 'Demo site, created by the growth engine',
        }),
      },
    );

    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: string };
      errors?: Array<{ message?: string; code?: number }>;
    };

    if (!response.ok || !body.success) {
      // 81057 is "record already exists", which is a success for our purposes.
      if (body.errors?.some((e) => e.code === 81057)) {
        return { ok: true, recordId: '' };
      }
      return {
        ok: false,
        error: body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${response.status}`,
      };
    }

    return { ok: true, recordId: body.result?.id ?? '' };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
