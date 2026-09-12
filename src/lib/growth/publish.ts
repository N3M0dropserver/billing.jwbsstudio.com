/**
 * Publishing a demo to a subdomain.
 *
 * Files go to R2 under `demos/<host>/` and this same Worker serves them when
 * a request arrives on a host it recognises. That means a demo is live the
 * instant it is generated, with no deploy step and nothing to wait for —
 * which is what a proposal email needs.
 *
 * DNS is the only part that needs arranging once, up front. A wildcard
 * record plus a wildcard Worker route covers every demo forever:
 *
 *     *.demo.jwbsstudio.com   CNAME   billing.jwbsstudio.com   (proxied)
 *     route: *.demo.jwbsstudio.com/*  →  this Worker
 *
 * With that in place `createDnsRecord` is never needed. It exists for the
 * case where you would rather create each record explicitly — set
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID and it is used automatically.
 */

import { contentTypeFor, demoPrefixFor, demoSourcePrefix, putObject } from './storage';
import type { GeneratedFile } from './render';

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
  const candidates = isReservedLabel(base) ? [`${base}-studio`] : [base];

  for (let suffix = 2; suffix <= 40; suffix++) candidates.push(`${base}-${suffix}`);

  for (const label of candidates) {
    const host = `${label}.${demoHost}`.toLowerCase();
    if (!(await taken(host))) return { label, host };
  }

  // Forty collisions on one name is not a naming problem any more.
  const label = `${base}-${Math.random().toString(36).slice(2, 7)}`;
  return { label, host: `${label}.${demoHost}`.toLowerCase() };
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
    return { ok: false, error: String(error) };
  }
}
