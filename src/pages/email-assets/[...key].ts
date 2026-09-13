import type { APIRoute } from 'astro';
import { files } from '~/lib/env';

export const prerender = false;

/**
 * Public read of images embedded in emails.
 *
 * Public by necessity: a mail client fetching an image sends no cookies, so
 * anything requiring a session renders as a broken image in every inbox.
 *
 * Scoped hard to the `email-assets/` prefix. The FILES bucket also holds
 * invoice PDFs under `invoices/`, and this route must never become a way to
 * read them — hence the explicit prefix and the traversal check rather than
 * trusting the router's parameter.
 */

const PREFIX = 'email-assets/';

/** Content types this route will serve, regardless of what R2 has recorded. */
const SERVABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const GET: APIRoute = async ({ params }) => {
  const suffix = params.key ?? '';

  // `..` in a key is not a path traversal in R2 (keys are opaque strings), but
  // it signals a caller probing for one, and nothing we write contains it.
  if (!suffix || suffix.includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  const object = await files().get(PREFIX + suffix);
  if (!object) return new Response('Not found', { status: 404 });

  const contentType = object.httpMetadata?.contentType ?? '';
  if (!SERVABLE.has(contentType)) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
      // Belt and braces: these are images, and the key is attacker-influenced
      // only in that the uploader chose the file.
      'x-content-type-options': 'nosniff',
    },
  });
};
