/**
 * R2 layout for the growth engine.
 *
 * Keys are built in one place so the prefixes stay predictable: deleting a
 * campaign, or a prospect, is then a prefix sweep rather than a hunt.
 *
 *   growth/<userId>/brand/<assetId>                 brand kit uploads
 *   growth/<userId>/<campaignId>/<prospectId>/...   everything per prospect
 *   demos/<host>/<path>                             the served demo files
 */

export const GROWTH_PREFIX = 'growth';
export const DEMO_PREFIX = 'demos';

export function brandAssetKey(userId: string, assetId: string, filename: string): string {
  return `${GROWTH_PREFIX}/${userId}/brand/${assetId}/${safeSegment(filename)}`;
}

export function prospectPrefix(userId: string, campaignId: string, prospectId: string): string {
  return `${GROWTH_PREFIX}/${userId}/${campaignId}/${prospectId}`;
}

export function crawlPageKey(prefix: string, index: number): string {
  return `${prefix}/crawl/page-${String(index).padStart(2, '0')}.html`;
}

export function crawlImageKey(prefix: string, index: number, extension: string): string {
  return `${prefix}/images/image-${String(index).padStart(2, '0')}.${safeSegment(extension)}`;
}

export function demoPrefixFor(host: string): string {
  return `${DEMO_PREFIX}/${host.toLowerCase()}`;
}

export function demoSourcePrefix(prefix: string): string {
  return `${prefix}/source`;
}

/** Strip anything that would change the shape of a key. */
export function safeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 100) || 'file'
  );
}

export interface StoredObject {
  key: string;
  bytes: number;
  contentType: string;
}

export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType: string,
  metadata: Record<string, string> = {},
): Promise<StoredObject> {
  const payload =
    typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);

  await bucket.put(key, payload, {
    httpMetadata: { contentType },
    // R2 rejects non-ASCII in custom metadata; the values here are derived
    // from somebody else's page titles, so they get flattened first.
    customMetadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, v.replace(/[^\x20-\x7e]/g, '').slice(0, 400)]),
    ),
  });

  return { key, bytes: payload.byteLength, contentType };
}

/** Delete everything under a prefix, a page of keys at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const listing = await bucket.list({ prefix, cursor, limit: 500 });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  return deleted;
}

const EXTENSION_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

/** File extension implied by a content type, for naming downloaded images. */
export function extensionFor(contentType: string): string {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  const found = Object.entries(EXTENSION_TYPES).find(([, type]) => type.split(';')[0] === base);
  return found?.[0] ?? 'bin';
}
