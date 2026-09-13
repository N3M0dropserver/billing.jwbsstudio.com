import type { APIRoute } from 'astro';
import { getAgentByName } from 'agents';
import { and, eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { campaigns } from '~/lib/db/schema';
import type { CampaignAgent } from '../../../../../workers/agent/src/index';

export const prerender = false;

/**
 * The live socket, proxied.
 *
 * The agent Worker has no authentication of its own and is deliberately not
 * given a public route — anyone who guessed a campaign id could otherwise
 * open a socket onto somebody else's run. So the browser connects here
 * instead, the session is checked against the campaign's owner, and only then
 * is the upgrade handed to the Durable Object.
 *
 * If the upgrade does not survive the adapter for any reason, the client
 * treats it as a closed socket and falls back to polling
 * `/api/campaigns/<id>/state`. Live updates are the nicety; the polled path
 * is what the page is actually correct on.
 */
export const GET: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorised', { status: 401 });

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade.', { status: 426 });
  }

  const id = String(params.id ?? '');
  const rows = await db()
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id)))
    .limit(1);

  if (!rows[0]) return new Response('Not found', { status: 404 });

  const env = bindings();
  const agent = await getAgentByName<Env, CampaignAgent>(
    env.CAMPAIGN_AGENT as unknown as DurableObjectNamespace<CampaignAgent>,
    id,
  );

  return agent.fetch(request);
};
