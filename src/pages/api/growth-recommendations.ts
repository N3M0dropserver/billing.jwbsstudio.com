import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { dismissRecommendation } from '~/lib/queries/recommendations';

export const prerender = false;

/**
 * Wave a suggestion away.
 *
 * The signature it was dismissed at is recorded, so the same suggestion at
 * worse numbers comes back. A dismissal is "I have decided about this", not
 * "never tell me anything about this again".
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return redirect('/growth', 302);

  await dismissRecommendation(db(), user.id, id, String(form.get('signature') ?? ''));

  return redirect('/growth', 302);
};
