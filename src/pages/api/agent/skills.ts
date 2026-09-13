import type { APIRoute } from 'astro';
import { db } from '~/lib/env';
import { CAMPAIGN_STAGES } from '~/lib/db/schema';
import {
  deleteSkill,
  getSkill,
  revertSkill,
  saveSkill,
  setSkillLock,
  setSkillStatus,
} from '~/lib/agent/skills';

export const prerender = false;

/**
 * Everything you can do to a skill.
 *
 * One endpoint for the same reason the campaign control route is one
 * endpoint: every action shares an ownership check and a redirect, and six
 * routes would be six copies of both.
 *
 * A skill saved here is always `active` and always authored by `user` — the
 * point of this page is that a person is deciding. The agent's own writes go
 * through `saveSkill` from the tool, which proposes rather than activates
 * unless self-improvement is set to `auto`.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const action = String(form.get('action') ?? 'save');
  const id = String(form.get('id') ?? '');
  const database = db();
  const text = (key: string) => String(form.get(key) ?? '').trim();

  const list = (key: string): string[] =>
    text(key)
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12);

  try {
    switch (action) {
      case 'save': {
        const existing = id ? await getSkill(database, user.id, id) : null;

        const stages = form
          .getAll('stages')
          .map((value) => String(value))
          .filter((stage) => (CAMPAIGN_STAGES as readonly string[]).includes(stage));

        const result = await saveSkill(database, {
          userId: user.id,
          author: 'user',
          slug: existing?.slug || text('slug') || undefined,
          name: text('name'),
          description: text('description'),
          whenToUse: text('whenToUse'),
          instructions: text('instructions'),
          stages,
          tags: list('tags'),
          rationale: text('rationale'),
          status: 'active',
          note: existing ? 'Edited by hand.' : 'Written by hand.',
        });

        if (!result.ok) {
          const where = existing ? `/growth/skills/${existing.id}` : '/growth/skills/new';
          return redirect(`${where}?error=${encodeURIComponent((result.problems ?? []).join(' '))}`, 302);
        }

        return redirect(`/growth/skills/${result.skill!.id}?saved=1`, 302);
      }

      case 'approve':
        await setSkillStatus(database, user.id, id, 'active');
        return redirect(`/growth/skills/${id}?saved=1`, 302);

      case 'archive':
        await setSkillStatus(database, user.id, id, 'archived');
        return redirect('/growth/skills', 302);

      case 'lock':
        await setSkillLock(database, user.id, id, true);
        return redirect(`/growth/skills/${id}`, 302);

      case 'unlock':
        await setSkillLock(database, user.id, id, false);
        return redirect(`/growth/skills/${id}`, 302);

      case 'revert': {
        const version = Number.parseInt(String(form.get('version') ?? ''), 10);
        const result = await revertSkill(database, user.id, id, version);
        if (!result.ok) {
          return redirect(`/growth/skills/${id}?error=${encodeURIComponent((result.problems ?? []).join(' '))}`, 302);
        }
        return redirect(`/growth/skills/${id}?saved=1`, 302);
      }

      case 'delete':
        await deleteSkill(database, user.id, id);
        return redirect('/growth/skills', 302);

      default:
        return new Response('Unknown action', { status: 400 });
    }
  } catch (error) {
    return redirect(`/growth/skills?error=${encodeURIComponent(String(error))}`, 302);
  }
};
