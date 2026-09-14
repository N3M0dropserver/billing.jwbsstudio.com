import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { campaigns, prospects } from '~/lib/db/schema';
import {
  decideCampaign,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
} from '~/lib/growth/agent-client';
import { policyFromForm, serialisePolicy, parsePolicy } from '~/lib/growth/policy';

export const prerender = false;

/**
 * Everything you can do to a running campaign.
 *
 * One endpoint rather than six, because they all share the same ownership
 * check and the same redirect, and splitting them would mean repeating both.
 */
export const POST: APIRoute = async ({ request, params, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const id = String(params.id ?? '');
  const database = db();

  // Scope by user id as well as campaign id: a guessed id must not act on
  // somebody else's run.
  const rows = await database
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id)))
    .limit(1);

  const campaign = rows[0];
  if (!campaign) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const back = `/growth/${id}`;
  const env = bindings();

  try {
    switch (action) {
      case 'start': {
        await database
          .update(campaigns)
          .set({
            status: 'running',
            startedAt: campaign.startedAt ?? new Date().toISOString(),
            // Also the retry path for a failed run: clear the last failure and
            // the completion stamp, or the page keeps reporting both.
            error: '',
            completedAt: null,
          })
          .where(eq(campaigns.id, id));
        await startCampaign(env, id, user.id);
        break;
      }

      case 'pause':
        await database.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, id));
        await pauseCampaign(env, id);
        break;

      case 'resume':
        await database.update(campaigns).set({ status: 'running' }).where(eq(campaigns.id, id));
        await resumeCampaign(env, id);
        break;

      case 'proceed':
        await decideCampaign(env, id, { action: 'proceed' });
        break;

      case 'stop':
        await decideCampaign(env, id, { action: 'stop' });
        break;

      case 'select': {
        const chosen = form.getAll('prospectId').map((value) => String(value));
        // Only ids that belong to this campaign.
        const owned = await database
          .select({ id: prospects.id })
          .from(prospects)
          .where(eq(prospects.campaignId, id));
        const valid = new Set(owned.map((row) => row.id));
        await decideCampaign(env, id, {
          action: 'select',
          prospectIds: chosen.filter((value) => valid.has(value)),
        });
        break;
      }

      case 'policy': {
        const merged = { ...parsePolicy(campaign.policy), ...policyFromForm(form) };
        await database
          .update(campaigns)
          .set({ policy: serialisePolicy(merged), updatedAt: new Date().toISOString() })
          .where(eq(campaigns.id, id));
        break;
      }

      default:
        return new Response('Unknown action', { status: 400 });
    }
  } catch (error) {
    return redirect(`${back}?error=${encodeURIComponent(String(error))}`, 302);
  }

  return redirect(back, 302);
};
