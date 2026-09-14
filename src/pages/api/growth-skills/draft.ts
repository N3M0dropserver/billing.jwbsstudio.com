import type { APIRoute } from 'astro';
import { bindings, db } from '~/lib/env';
import { draftSkill } from '~/lib/growth/skill-draft';
import { isSkillStage } from '~/lib/growth/skills';
import { getSettings } from '~/lib/queries/settings';

export const prerender = false;

/**
 * Draft a skill from a description.
 *
 * The draft comes back in the query string and lands in the form, unsaved.
 * Nothing is written until the user presses save, because a skill written by
 * a model and stored without being read is exactly the thing that puts an
 * instruction nobody chose into every prompt.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const description = String(form.get('description') ?? '').trim();
  if (!description) {
    return redirect('/growth/skills/new?error=Say+what+the+skill+should+cover', 302);
  }

  const stageParam = String(form.get('stage') ?? '');
  const database = db();
  const settings = await getSettings(database, user.id);

  const result = await draftSkill(
    bindings().AI,
    description,
    {
      db: database,
      userId: user.id,
      operation: 'skill-draft',
      stage: 'skills',
      cacheTtlHours: settings.aiCacheTtlHours,
    },
    isSkillStage(stageParam) ? stageParam : undefined,
  );

  if (!result.ok) {
    return redirect(
      `/growth/skills/new?error=${encodeURIComponent(`Could not draft that: ${result.error}`)}`,
      302,
    );
  }

  const draft = result.data;
  const params = new URLSearchParams({
    drafted: '1',
    name: draft.name,
    stage: draft.stage,
    summary: draft.summary,
    instructions: draft.instructions,
    niches: draft.match.niches.join(','),
    objectives: draft.match.objectives.join(','),
    website: draft.match.website,
  });

  return redirect(`/growth/skills/new?${params.toString()}`, 302);
};
