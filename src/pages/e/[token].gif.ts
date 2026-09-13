import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { recordOpen } from '~/lib/queries/sends';
import { pixelBytes } from '~/lib/mail/tracking';

export const prerender = false;

/**
 * The open-tracking pixel.
 *
 * Unauthenticated by design — the caller is a mail client, and the token in
 * the URL is the only credential. An unknown token is not an error worth
 * reporting; it returns the same image as a known one, so probing this
 * endpoint reveals nothing about which tokens exist.
 *
 * The image is returned whatever happens. A database failure must not leave a
 * broken-image icon in a client's inbox — the tracking is the optional part
 * here, not the pixel.
 */
export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const token = (params.token ?? '').slice(0, 200);

  if (token) {
    try {
      await recordOpen(db(), token, {
        userAgent: request.headers.get('user-agent'),
        ip: clientAddress ?? null,
      });
    } catch {
      // Never let a tracking failure show up in someone's email.
    }
  }

  return new Response(pixelBytes() as BodyInit, {
    headers: {
      'content-type': 'image/gif',
      // Must not be cached anywhere, or repeat opens never reach us. Gmail's
      // proxy caches regardless; this at least stops everything else.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      expires: '0',
    },
  });
};
