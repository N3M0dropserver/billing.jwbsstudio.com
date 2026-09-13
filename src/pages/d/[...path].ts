import type { APIRoute } from 'astro';
import { files } from '~/lib/env';
import { parseDemoPath, serveDemo } from '~/lib/growth/publish';

export const prerender = false;

/**
 * Generated demos, on the app's own origin.
 *
 * The wildcard subdomain is the nicer address, but it needs a DNS record and
 * a Worker route that somebody has to set up first — and until they do, every
 * demo link is dead. This mount always works, so a run produces something
 * openable the moment it finishes rather than after a DNS change.
 *
 * Public by design: a demo is meant to be shown to someone who has no account
 * here. It serves only files under `demos/<host>/`, and `serveDemo` cannot be
 * walked out of that prefix.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const parsed = parseDemoPath(url.pathname);
  if (!parsed) return new Response('Not found', { status: 404 });

  // Assets inside a demo are referenced relatively, so the page has to sit at
  // a path ending in a slash — otherwise `styles.css` resolves against `/d/`.
  if (parsed.rest === '/' && !url.pathname.endsWith('/')) {
    return new Response(null, {
      status: 308,
      headers: { location: `${url.pathname}/${url.search}` },
    });
  }

  const served = await serveDemo(files(), parsed.host, new URL(parsed.rest, url.origin), request);
  if (!served) {
    return new Response(
      'No demo has been published at this address. It may have been archived, or the build may have failed.',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  return served;
};
