import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db, files } from '~/lib/env';
import { expenses } from '~/lib/db/schema';

export const prerender = false;

/** The stored receipt image for one expense. Owner only. */
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const rows = await db()
    .select({ receiptKey: expenses.receiptKey })
    .from(expenses)
    .where(and(eq(expenses.id, params.id!), eq(expenses.userId, user.id)))
    .limit(1);

  const key = rows[0]?.receiptKey;
  if (!key) return new Response('No receipt on file for that expense', { status: 404 });

  const object = await files().get(key);
  if (!object) return new Response('The stored receipt has gone missing', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
      // An uploaded image is untrusted content served from our own origin.
      'content-security-policy': "default-src 'none'; img-src 'self'",
      'x-content-type-options': 'nosniff',
    },
  });
};
