import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { createInvoiceTemplate } from '~/lib/queries/invoice-templates';
import { DEFAULT_DESIGN } from '~/lib/pdf/template';

export const prerender = false;

/**
 * The "New template" button on the list page.
 *
 * A plain form post rather than fetch, so the page works before its React
 * islands hydrate — and straight into the designer, because a template with
 * no design chosen is not worth a confirmation screen.
 */
export const POST: APIRoute = async ({ locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const created = await createInvoiceTemplate(db(), user.id, {
    name: 'New template',
    design: DEFAULT_DESIGN,
    // Never steals the default from whatever is already producing invoices.
    isDefault: false,
  });

  return redirect(`/invoices/templates/${created.id}`, 302);
};
