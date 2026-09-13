import type { APIRoute } from 'astro';
import { bindings, db } from '~/lib/env';
import { startResearch } from '~/lib/growth/agent-client';
import { loadAgentSettings } from '~/lib/agent/context';
import { countResearchToday, createResearch } from '~/lib/agent/research';

export const prerender = false;

/**
 * Start a research task.
 *
 * The cap is checked here as well as in the pipeline. A person asking a
 * question by hand is not the thing the cap exists to restrain, so their
 * tasks are counted but not blocked until they are plainly running a loop —
 * twice the unattended allowance.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const question = String(form.get('question') ?? '').trim();
  const subject = String(form.get('subject') ?? '').trim();

  if (question.length < 8) {
    return redirect('/growth/research?error=' + encodeURIComponent('Ask a fuller question than that.'), 302);
  }

  const database = db();
  const settings = await loadAgentSettings(database, user.id);
  const startedToday = await countResearchToday(database, user.id);

  if (startedToday >= settings.researchDailyCap * 2) {
    return redirect(
      '/growth/research?error=' +
        encodeURIComponent(
          `That is ${startedToday} research tasks in a day, which is past twice the cap in your settings. Raise the cap if you meant it.`,
        ),
      302,
    );
  }

  const budget = Number.parseInt(String(form.get('stepBudget') ?? ''), 10);

  const research = await createResearch(database, {
    userId: user.id,
    question,
    subject,
    origin: 'user',
    campaignId: String(form.get('campaignId') ?? '') || null,
    prospectId: String(form.get('prospectId') ?? '') || null,
    stepBudget: Number.isFinite(budget) ? budget : settings.stepBudget,
  });

  try {
    await startResearch(bindings(), research.id, user.id);
  } catch (error) {
    return redirect(`/growth/research/${research.id}?error=${encodeURIComponent(String(error))}`, 302);
  }

  return redirect(`/growth/research/${research.id}`, 302);
};
