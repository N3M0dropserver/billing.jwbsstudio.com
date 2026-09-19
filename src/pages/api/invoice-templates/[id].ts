import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import {
  archiveInvoiceTemplate,
  getInvoiceTemplate,
  updateInvoiceTemplate,
} from '~/lib/queries/invoice-templates';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const template = await getInvoiceTemplate(db(), user.id, params.id!);
  if (!template) return new Response('Template not found', { status: 404 });

  return Response.json(template);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }

  const updated = await updateInvoiceTemplate(db(), user.id, params.id!, {
    name: typeof body.name === 'string' ? body.name.slice(0, 120) : undefined,
    description: typeof body.description === 'string' ? body.description.slice(0, 300) : undefined,
    design: 'design' in body ? body.design : undefined,
    isDefault: typeof body.isDefault === 'boolean' ? body.isDefault : undefined,
  });

  if (!updated) return new Response('Template not found', { status: 404 });
  return Response.json({ ok: true, updatedAt: updated.updatedAt, template: updated });
};

/**
 * Retire a template.
 *
 * Soft — invoices issued under it keep rendering the way they were sent. See
 * `archiveInvoiceTemplate`.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const archived = await archiveInvoiceTemplate(db(), user.id, params.id!);
  if (!archived) return new Response('Template not found', { status: 404 });

  return Response.json({ ok: true });
};
