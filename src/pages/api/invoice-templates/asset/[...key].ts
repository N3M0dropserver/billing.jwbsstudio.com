import type { APIRoute } from 'astro';
import { files } from '~/lib/env';
import { LOGO_PREFIX } from '~/lib/invoices/branding';

export const prerender = false;

/**
 * Authenticated read of a template's logo, for the designer's own thumbnail.
 *
 * Unlike `/email-assets/`, this is behind the session: a logo is not embedded
 * in anything a stranger fetches, so there is no reason to publish it.
 *
 * Scoped twice. The key must sit under `invoice-assets/`, and under the
 * requesting user's own id within it — the same bucket holds every invoice PDF
 * this system has ever issued, under `invoices/<user>/`, and this route must
 * never become a way to read one.
 */
const SERVABLE = new Set(['image/png', 'image/jpeg']);

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const suffix = params.key ?? '';
  if (!suffix || suffix.includes('..')) return new Response('Not found', { status: 404 });

  // `invoice-assets/<user>/<id>.png` — anything not under this user's own
  // folder is not theirs to read, whatever the key says.
  if (!suffix.startsWith(`${user.id}/`)) return new Response('Not found', { status: 404 });

  const object = await files().get(LOGO_PREFIX + suffix);
  if (!object) return new Response('Not found', { status: 404 });

  const contentType = object.httpMetadata?.contentType ?? '';
  if (!SERVABLE.has(contentType)) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': contentType,
      // Keys are random and content never changes under one, so this is safe
      // to cache hard — but privately: it is behind a session.
      'cache-control': 'private, max-age=31536000, immutable',
      etag: object.httpEtag,
      'x-content-type-options': 'nosniff',
    },
  });
};
