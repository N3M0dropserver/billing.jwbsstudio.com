import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { isSkillStage } from '~/lib/growth/skills';
import { deleteSkill, matchFromForm, saveSkill, setSkillEnabled } from '~/lib/queries/skills';

export const prerender = false;

/**
 * Save, toggle or remove a skill.
 *
 * One route for the three because they all take a slug and all end back on
 * the same page; splitting them would be three files that differ by a verb.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const action = String(form.get('action') ?? 'save');
  const slug = String(form.get('slug') ?? '').slice(0, 80);
  const database = db();

  if (action === 'delete') {
    if (!slug) return redirect('/growth/skills', 302);
    await deleteSkill(database, user.id, slug);
    return redirect('/growth/skills?removed=1', 302);
  }

  if (action === 'toggle') {
    if (!slug) return redirect('/growth/skills', 302);
    await setSkillEnabled(database, user.id, slug, form.get('enabled') === 'yes');
    return redirect('/growth/skills?saved=1', 302);
  }

  const stage = String(form.get('stage') ?? '');
  if (!isSkillStage(stage)) {
    return redirect('/growth/skills/new?error=Pick+a+stage+for+the+skill', 302);
  }

  const instructions = String(form.get('instructions') ?? '').trim();
  if (!instructions) {
    return redirect('/growth/skills/new?error=A+skill+with+no+instructions+does+nothing', 302);
  }

  await saveSkill(database, user.id, {
    slug: slug || undefined,
    name: String(form.get('name') ?? '').trim(),
    stage,
    summary: String(form.get('summary') ?? '').trim(),
    instructions,
    match: matchFromForm(form),
    enabled: form.get('enabled') === 'yes',
  });

  return redirect('/growth/skills?saved=1', 302);
};
