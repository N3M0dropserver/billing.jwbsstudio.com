import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import {
  archiveTemplate,
  duplicateTemplate,
  getTemplate,
  updateTemplate,
  type TemplateUpdate,
} from '~/lib/queries/templates';
import { isTemplateKind } from '~/lib/mail/variables';

export const prerender = false;

/**
 * Bodies are stored as the editor produced them.
 *
 * They are authored by the account owner and only ever sent as email, never
 * rendered into an authenticated page of this app — so there is no sanitising
 * step here beyond the size cap. The one place a template's HTML is displayed
 * back is the preview, which uses a sandboxed iframe.
 */
const MAX_BODY = 400_000;

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }

  const patch: TemplateUpdate = {};

  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120) || 'Untitled';
  if (typeof body.subject === 'string') patch.subject = body.subject.slice(0, 500);
  if (typeof body.doc === 'string') patch.doc = body.doc.slice(0, MAX_BODY);
  if (typeof body.html === 'string') patch.html = body.html.slice(0, MAX_BODY);
  if (typeof body.text === 'string') patch.text = body.text.slice(0, MAX_BODY);
  if (typeof body.isDefault === 'boolean') patch.isDefault = body.isDefault;
  if (isTemplateKind(body.kind)) patch.kind = body.kind;

  const updated = await updateTemplate(db(), user.id, params.id!, patch);
  if (!updated) return new Response('Template not found', { status: 404 });

  return Response.json({ ok: true, updatedAt: updated.updatedAt });
};

/** Form-posted actions from the list page: `duplicate`, or set as default. */
export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const database = db();

  if (action === 'duplicate') {
    const copy = await duplicateTemplate(database, user.id, params.id!);
    if (!copy) return new Response('Template not found', { status: 404 });
    return redirect(`/templates/${copy.id}`, 302);
  }

  if (action === 'default') {
    const existing = await getTemplate(database, user.id, params.id!);
    if (!existing) return new Response('Template not found', { status: 404 });
    await updateTemplate(database, user.id, params.id!, { isDefault: true });
    return redirect('/templates', 302);
  }

  if (action === 'archive') {
    const ok = await archiveTemplate(database, user.id, params.id!);
    if (!ok) return new Response('Template not found', { status: 404 });
    return redirect('/templates', 302);
  }

  return new Response(`Unknown action "${action}"`, { status: 400 });
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const ok = await archiveTemplate(db(), user.id, params.id!);
  if (!ok) return new Response('Template not found', { status: 404 });

  return Response.json({ ok: true });
};
