import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { createTemplate, listTemplates } from '~/lib/queries/templates';
import { isTemplateKind } from '~/lib/mail/variables';
import { starterById } from '~/lib/mail/starters';

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

  /*
   * The base template, if one was picked.
   *
   * Only its subject is stored here. The body is HTML and the column holds
   * editor JSON, and converting one to the other needs the Tiptap schema —
   * which stays out of the Worker on purpose. So the id rides along on the
   * redirect and the editor applies the body in the browser.
   */
  const starter = starterById(form.get('starter')?.toString());
  const usable = starter?.kinds.includes(kind) ? starter : null;

  const created = await createTemplate(db(), user.id, {
    name,
    kind,
    subject: usable?.subject ?? '',
  });

  // Straight into the editor — a template with no body is not worth a
  // confirmation screen.
  const query = usable ? `?start=${encodeURIComponent(usable.id)}` : '';
  return redirect(`/templates/${created.id}${query}`, 302);
};
