import type { APIRoute } from 'astro';
import { getAgentByName } from 'agents';
import { and, eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { agentResearch } from '~/lib/db/schema';
import type { ResearchAgent } from '../../../../../../workers/agent/src/index';

export const prerender = false;

/**
 * The live socket for a research task, proxied and authenticated.
 *
 * Same reasoning as the campaign socket: the agent Worker has no auth of its
 * own and no public route, so the session is checked against the task's owner
 * here and only then is the upgrade handed on.
 */
export const GET: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorised', { status: 401 });

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade.', { status: 426 });
  }

  const id = String(params.id ?? '');
  const rows = await db()
    .select({ id: agentResearch.id })
    .from(agentResearch)
    .where(and(eq(agentResearch.id, id), eq(agentResearch.userId, user.id)))
    .limit(1);

  if (!rows[0]) return new Response('Not found', { status: 404 });

  const env = bindings();
  const agent = await getAgentByName<Env, ResearchAgent>(
    env.RESEARCH_AGENT as unknown as DurableObjectNamespace<ResearchAgent>,
    id,
  );

  return agent.fetch(request);
};
