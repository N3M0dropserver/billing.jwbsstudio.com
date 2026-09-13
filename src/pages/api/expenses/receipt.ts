import type { APIRoute } from 'astro';
import { db, files, ai } from '~/lib/env';
import { newId } from '~/lib/id';
import { readReceipt } from '~/lib/ai/receipt';
import { activityLog } from '~/lib/db/schema';

export const prerender = false;

/**
 * Take a photograph of a receipt, keep it, and read it.
 *
 * Two things happen and they are deliberately independent. The image is
 * stored in R2 first and the key comes back whatever the model does, because
 * the picture IS the record both revenue authorities expect you to retain —
 * losing it because an AI call timed out would be the worse failure by far.
 * The reading is a convenience on top.
 */

/** Cloudflare Email caps a message at 5 MiB; a phone photo is well under this. */
const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const form = await request.formData();
  const file = form.get('receipt');

  if (!(file instanceof File)) {
    return Response.json({ error: 'No file was attached.' }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: 'That file was empty.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 8 MB.` },
      { status: 413 },
    );
  }
  if (!ALLOWED.has(file.type)) {
    return Response.json(
      { error: `${file.type || 'That file'} is not an image this can read. Use JPEG, PNG or WebP.` },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /**
   * Keyed under the user id, and the key is checked against that prefix again
   * when an expense is saved — so a key from one account can never be
   * attached to another's record.
   */
  const key = `receipts/${user.id}/${newId()}`;

  try {
    await files().put(key, bytes, {
      httpMetadata: { contentType: file.type },
      customMetadata: { uploadedBy: user.id, originalName: file.name.slice(0, 200) },
    });
  } catch (error) {
    return Response.json(
      { error: `Could not store that receipt: ${String(error)}` },
      { status: 502 },
    );
  }

  const reading = await readReceipt(ai(), { bytes, contentType: file.type });

  await db().insert(activityLog).values({
    id: newId(),
    userId: user.id,
    action: 'expense.receipt-uploaded',
    entityType: 'expense',
    detail: JSON.stringify({ key, bytes: file.size, read: reading.ok }),
    createdAt: new Date().toISOString(),
  });

  if (!reading.ok) {
    // The image is safely stored; only the reading failed. Say so, and let
    // the user type the figures rather than losing their upload.
    return Response.json({ receiptKey: key, read: false, error: reading.error });
  }

  return Response.json({ receiptKey: key, read: true, reading: reading.data });
};
