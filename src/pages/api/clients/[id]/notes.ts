import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { clients, communications } from '~/lib/db/schema';
import { newId } from '~/lib/id';

export const prerender = false;

const KINDS = new Set(['email', 'call', 'meeting', 'note', 'follow-up']);

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const clientId = params.id!;
  const owned = await db()
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, user.id)))
    .limit(1);

  if (!owned[0]) return new Response('Client not found', { status: 404 });

  const form = await request.formData();
  const body = String(form.get('body') ?? '').trim();
  if (!body) return redirect(`/clients/${clientId}`, 302);

  const kind = String(form.get('kind') ?? 'note');
  const now = new Date().toISOString();

  await db().insert(communications).values({
    id: newId(),
    userId: user.id,
    clientId,
    kind: (KINDS.has(kind) ? kind : 'note') as 'note',
    subject: String(form.get('subject') ?? '').slice(0, 200),
    body: body.slice(0, 5000),
    occurredAt: String(form.get('occurredAt') ?? now),
    followUpAt: String(form.get('followUpAt') ?? '') || null,
    createdAt: now,
  });

  return redirect(`/clients/${clientId}`, 302);
};
