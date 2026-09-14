import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { agentResearch } from '~/lib/db/schema';
import { researchSteps } from '~/lib/agent/research';
import { researchState } from '~/lib/growth/agent-client';

export const prerender = false;

/**
 * The polled view of a research task.
 *
 * The same arrangement as a campaign's state route: D1 is the truth and the
 * agent's own state is the extra. A page that renders correctly with the
 * Durable Object unreachable is worth more than one that only works when
 * everything is up.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorised', { status: 401 });

  const id = String(params.id ?? '');
  const database = db();

  const rows = await database
    .select()
    .from(agentResearch)
    .where(and(eq(agentResearch.id, id), eq(agentResearch.userId, user.id)))
    .limit(1);

  const research = rows[0];
  if (!research) return new Response('Not found', { status: 404 });

  const [steps, agent] = await Promise.all([
    researchSteps(database, id),
    researchState(bindings(), id).catch(() => null),
  ]);

  return Response.json(
    { research, steps, agent },
    { headers: { 'cache-control': 'no-store' } },
  );
};
