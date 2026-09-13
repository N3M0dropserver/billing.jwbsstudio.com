import type { APIRoute } from 'astro';
import { files, appUrl } from '~/lib/env';
import { newId } from '~/lib/id';

export const prerender = false;

/**
 * Images dropped into the email editor.
 *
 * Stored in R2 under `email-assets/`, which is the one prefix served publicly
 * (see src/pages/email-assets/[...key].ts). It has to be public: a mail client
 * fetching an image carries no session, so anything behind auth renders as a
 * broken image in every inbox it lands in.
 *
 * Keys are random, so the URL is unguessable, but treat anything uploaded here
 * as published. Do not put a client's documents through this route.
 */

/** Raster formats every mail client renders. SVG is excluded deliberately —
 *  it is a script container, and it is poorly supported in email anyway. */
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Gmail clips messages over ~102 KB of HTML; large images also just hurt. */
const MAX_BYTES = 2 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return Response.json({ error: 'No file was uploaded.' }, { status: 400 });
  }

  const extension = ALLOWED[file.type];
  if (!extension) {
    return Response.json(
      { error: `${file.type || 'That file type'} cannot be used in email. Use PNG, JPEG, GIF or WebP.` },
      { status: 415 },
    );
  }

  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Keep images under 2 MB.` },
      { status: 413 },
    );
  }

  const key = `email-assets/${user.id}/${newId()}.${extension}`;

  await files().put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  });

  // Absolute, because a relative src is meaningless inside an inbox.
  return Response.json({ url: `${appUrl()}/${key}` });
};
