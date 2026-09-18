import type { APIRoute } from 'astro';
import { files } from '~/lib/env';
import { newId } from '~/lib/id';
import { decodeImage, ImageError } from '~/lib/pdf/image';
import { LOGO_PREFIX, MAX_LOGO_BYTES } from '~/lib/invoices/branding';

export const prerender = false;

/**
 * A logo dropped into the template designer.
 *
 * Stored under `invoice-assets/<user>/`, which — unlike `email-assets/` — is
 * NOT served publicly. It never needs to be: the logo is embedded in the PDF
 * itself, so nothing outside this app ever fetches it by URL. See
 * `src/pages/api/invoice-templates/asset/[...key].ts` for the authenticated
 * read the designer uses.
 *
 * Only PNG and JPEG, because those are the two formats a PDF can carry
 * without re-encoding. SVG is excluded for the same reason it is excluded
 * from email: it is a script container, and PDF cannot embed it anyway.
 */
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

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
      { error: `${file.type || 'That file type'} cannot be placed on a PDF. Use a PNG or a JPEG.` },
      { status: 415 },
    );
  }

  if (file.size > MAX_LOGO_BYTES) {
    return Response.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Keep a logo under 2 MB.` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /*
   * Decoded before it is stored, not when an invoice is rendered.
   *
   * An interlaced PNG or a 16-bit indexed one is a perfectly ordinary file
   * that this renderer cannot place. Finding that out here means the person
   * is told, in the designer, while they are looking at the file picker —
   * rather than an invoice quietly going out without its logo weeks later.
   */
  let dimensions: { width: number; height: number };
  try {
    const image = await decodeImage(bytes);
    dimensions = { width: image.width, height: image.height };
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ImageError
            ? error.message
            : 'That image could not be read. Try re-saving it as a PNG.',
      },
      { status: 415 },
    );
  }

  const key = `${LOGO_PREFIX}${user.id}/${newId()}.${extension}`;
  await files().put(key, bytes, { httpMetadata: { contentType: file.type } });

  return Response.json({ key, ...dimensions });
};
