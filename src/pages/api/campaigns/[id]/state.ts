import type { APIRoute } from 'astro';
import { and, desc, eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { campaignEvents, campaigns, demoSites, prospects } from '~/lib/db/schema';
import { campaignState } from '~/lib/growth/agent-client';

export const prerender = false;

/**
 * The live view's data.
 *
 * D1 is authoritative; the agent's own state is folded in when it answers.
 * The page works either way — a campaign whose agent is mid-restart still
 * renders, just without the tick counter.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorised', { status: 401 });

  const id = String(params.id ?? '');
  const database = db();

  const rows = await database
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id)))
    .limit(1);

  const campaign = rows[0];
  if (!campaign) return new Response('Not found', { status: 404 });

  const [events, found, demos, agent] = await Promise.all([
    database
      .select()
      .from(campaignEvents)
      .where(eq(campaignEvents.campaignId, id))
      .orderBy(desc(campaignEvents.createdAt))
      .limit(60),
    database
      .select()
      .from(prospects)
      .where(eq(prospects.campaignId, id))
      .orderBy(desc(prospects.score))
      .limit(200),
    database.select().from(demoSites).where(eq(demoSites.campaignId, id)),
    campaignState(bindings(), id),
  ]);

  return new Response(
    JSON.stringify({
      campaign,
      events,
      prospects: found,
      demos,
      agent,
    }),
    {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  );
};
