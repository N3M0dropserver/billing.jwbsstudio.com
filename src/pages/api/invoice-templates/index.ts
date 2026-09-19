import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import {
  createInvoiceTemplate,
  listInvoiceTemplates,
  seedInvoiceTemplates,
} from '~/lib/queries/invoice-templates';

export const prerender = false;

/**
 * The account's templates, seeding the starter set on first look.
 *
 * Seeding here rather than at signup keeps the feature opt-in: an account that
 * never opens the designer has no rows, and `designFor` hands back the
 * built-in design — the same invoice this system produced before templates
 * existed.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  const database = db();
  const existing = await listInvoiceTemplates(database, user.id);
  const rows = existing.length ? existing : await seedInvoiceTemplates(database, user.id);

  return Response.json(rows);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not authenticated', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }

  const created = await createInvoiceTemplate(db(), user.id, {
    name: String(body.name ?? '').slice(0, 120),
    description: String(body.description ?? '').slice(0, 300),
    // `createInvoiceTemplate` normalises, so whatever arrives here is safe.
    design: body.design,
    isDefault: typeof body.isDefault === 'boolean' ? body.isDefault : undefined,
  });

  return Response.json(created, { status: 201 });
};
