import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { MAX_PROMPT_LENGTH } from '~/lib/growth/prompts';
import { savePromptOverride, toPromptKey } from '~/lib/queries/prompts';

export const prerender = false;

/**
 * Save one edited prompt, or put it back.
 *
 * "Reset" is a save of nothing rather than a separate route: both end in the
 * same place, which is a user with no override row and therefore the default
 * in force — including any later improvement to it.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const key = toPromptKey(form.get('key'));
  if (!key) return redirect('/growth/prompts?error=Unknown+prompt', 302);

  const resetting = form.get('action') === 'reset';
  const instructions = resetting ? '' : String(form.get('instructions') ?? '').slice(0, MAX_PROMPT_LENGTH);

  await savePromptOverride(db(), user.id, key, instructions);

  return redirect(`/growth/prompts?${resetting ? 'reset' : 'saved'}=1#${key}`, 302);
};
