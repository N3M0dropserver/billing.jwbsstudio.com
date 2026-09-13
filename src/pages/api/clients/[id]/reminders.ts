import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { clients } from '~/lib/db/schema';

export const prerender = false;

/**
 * Exclude a client from automatic chasing.
 *
 * Some clients are paid by their own accounts-payable calendar and a reminder
 * only irritates them; some you would simply rather ring.
 */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const owned = await database
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, params.id!), eq(clients.userId, user.id)))
    .limit(1);

  if (!owned[0]) return new Response('Client not found', { status: 404 });

  const form = await request.formData();
  await database
    .update(clients)
    .set({ remindersEnabled: form.get('enabled') === 'yes', updatedAt: new Date().toISOString() })
    .where(eq(clients.id, params.id!));

  return redirect(`/clients/${params.id}`, 302);
};
