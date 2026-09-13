/**
 * Talking to the campaign agent from the app.
 *
 * The agent is a Durable Object in another Worker, reached through the
 * `CAMPAIGN_AGENT` binding. One instance per campaign id, so every call about
 * a campaign lands on the same object and the run has exactly one writer.
 *
 * The type import below is erased at build time — it gives typed RPC against
 * the agent's methods without the app bundling the agent's code.
 */

import { getAgentByName } from 'agents';
import type {
  CampaignAgent,
  CampaignState,
  ResearchAgent,
  ResearchState,
} from '../../../workers/agent/src/index';
import type { GateDecision } from './engine';

export type { CampaignState, ResearchState };

async function stub(env: Env, campaignId: string) {
  return getAgentByName<Env, CampaignAgent>(
    env.CAMPAIGN_AGENT as unknown as DurableObjectNamespace<CampaignAgent>,
    campaignId,
  );
}

export async function startCampaign(
  env: Env,
  campaignId: string,
  userId: string,
): Promise<CampaignState> {
  const agent = await stub(env, campaignId);
  return agent.begin(campaignId, userId);
}

export async function decideCampaign(
  env: Env,
  campaignId: string,
  decision: GateDecision,
): Promise<CampaignState> {
  const agent = await stub(env, campaignId);
  return agent.decide(decision);
}

export async function pauseCampaign(env: Env, campaignId: string): Promise<CampaignState> {
  const agent = await stub(env, campaignId);
  return agent.pause();
}

export async function resumeCampaign(env: Env, campaignId: string): Promise<CampaignState> {
  const agent = await stub(env, campaignId);
  return agent.resume();
}

/**
 * The agent's own view of the run.
 *
 * Returns null rather than throwing when the agent cannot be reached — the
 * campaign page reads D1 for everything that matters and treats this as the
 * live extra, so a page that still renders is better than one that 500s
 * because a Durable Object was mid-restart.
 */
export async function campaignState(env: Env, campaignId: string): Promise<CampaignState | null> {
  try {
    const agent = await stub(env, campaignId);
    const response = await agent.fetch('https://agent/');
    if (!response.ok) return null;
    return (await response.json()) as CampaignState;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Research                                                            */
/* ------------------------------------------------------------------ */

async function researchStub(env: Env, researchId: string) {
  return getAgentByName<Env, ResearchAgent>(
    env.RESEARCH_AGENT as unknown as DurableObjectNamespace<ResearchAgent>,
    researchId,
  );
}

/**
 * Hand a queued research task to its own Durable Object.
 *
 * One object per task id, so a second press of Start lands on the same object
 * and finds it already running rather than starting a second loop over the
 * same question.
 */
export async function startResearch(
  env: Env,
  researchId: string,
  userId: string,
): Promise<ResearchState> {
  const agent = await researchStub(env, researchId);
  return agent.begin(researchId, userId);
}

/** The agent's live view of a task. Null when it cannot be reached. */
export async function researchState(env: Env, researchId: string): Promise<ResearchState | null> {
  try {
    const agent = await researchStub(env, researchId);
    const response = await agent.fetch('https://agent/');
    if (!response.ok) return null;
    return (await response.json()) as ResearchState;
  } catch {
    return null;
  }
}
