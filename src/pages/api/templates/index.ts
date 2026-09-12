import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { createTemplate, listTemplates } from '~/lib/queries/templates';
import { isTemplateKind } from '~/lib/mail/variables';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const rows = await listTemplates(db(), user.id);
  return Response.json(rows);
};

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim().slice(0, 120) || 'Untitled template';
  const kindRaw = String(form.get('kind') ?? 'general');
  const kind = isTemplateKind(kindRaw) ? kindRaw : 'general';

  const created = await createTemplate(db(), user.id, { name, kind });

  // Straight into the editor — a template with no body is not worth a
  // confirmation screen.
  return redirect(`/templates/${created.id}`, 302);
};
