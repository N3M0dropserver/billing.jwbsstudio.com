/**
 * The campaign agent.
 *
 * One Durable Object per campaign, built on the Cloudflare Agents SDK. It is
 * the right shape for this problem for three reasons:
 *
 *   - A run takes minutes to hours and outlives any request. `this.schedule`
 *     persists across restarts, evictions and deploys, so a run that starts
 *     on Tuesday finishes on Tuesday whether or not anybody keeps a tab open.
 *   - A run is a single-writer state machine. A Durable Object gives that for
 *     free: one instance per campaign id, no locking, no lost updates from two
 *     ticks racing each other.
 *   - `setState` broadcasts to every connected client. The live run view is a
 *     WebSocket subscriber rather than a polling loop, so progress appears as
 *     it happens without hammering D1.
 *
 * The pipeline logic is not here — it lives in `src/lib/growth/engine.ts`, as
 * ordinary functions over a database handle. This file is the part that knows
 * about durability: when to tick, what to do when a tick throws, and how to
 * stop cleanly. That separation keeps the interesting logic testable in plain
 * Node.
 *
 * This is a Worker of its own, deployed separately, because the Astro
 * Cloudflare adapter generates the app's Worker entry and there is no
 * supported way to add a Durable Object export to it. The app binds this one
 * by `script_name`.
 */

import { Agent, getAgentByName, routeAgentRequest } from 'agents';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../src/lib/db/index';
import { settings } from '../../../src/lib/db/schema';
import {
  decideGate,
  loadCampaign,
  logEvent,
  tick,
  type EngineContext,
  type GateDecision,
  type StepResult,
} from '../../../src/lib/growth/engine';
import type { CampaignStage } from '../../../src/lib/db/schema';

export interface CampaignState {
  campaignId: string;
  userId: string;
  stage: CampaignStage | '';
  status: string;
  waitingOn: CampaignStage | null;
  /** The last few lines, for a client that has just connected. */
  recent: Array<{ at: string; message: string }>;
  ticks: number;
  lastTickAt: string | null;
  error: string;
}

/** How long to wait before the next tick while a run is active. */
const TICK_DELAY_SECONDS = 1;

/**
 * A run that has gone quiet without finishing gets one nudge.
 *
 * Ticks are chained, so a lost one would otherwise strand the run forever —
 * this is the watchdog that notices.
 */
const WATCHDOG_SECONDS = 900;

export class CampaignAgent extends Agent<Env, CampaignState> {
  initialState: CampaignState = {
    campaignId: '',
    userId: '',
    stage: '',
    status: 'idle',
    waitingOn: null,
    recent: [],
    ticks: 0,
    lastTickAt: null,
    error: '',
  };

  private context(cacheTtlHours?: number): EngineContext {
    return {
      db: getDb(this.env.DB),
      bucket: this.env.FILES,
      ai: this.env.AI,
      env: this.env,
      appUrl: this.env.APP_URL || 'https://billing.jwbsstudio.com',
      aiCacheTtlHours: cacheTtlHours,
    };
  }

  /**
   * The user's AI cache setting, read once per tick rather than per call.
   *
   * A tick makes several model calls and they all want the same number; a
   * read each time would be a D1 round trip for a value that cannot change
   * mid-tick.
   */
  private async cacheTtl(): Promise<number> {
    if (!this.state.userId) return 0;
    try {
      const rows = await getDb(this.env.DB)
        .select({ hours: settings.aiCacheTtlHours })
        .from(settings)
        .where(eq(settings.userId, this.state.userId))
        .limit(1);
      return rows[0]?.hours ?? 0;
    } catch {
      return 0;
    }
  }

  private note(message: string): Array<{ at: string; message: string }> {
    return [
      ...this.state.recent.slice(-24),
      { at: new Date().toISOString(), message: message.slice(0, 300) },
    ];
  }

  /**
   * Begin, or resume, a run.
   *
   * Idempotent: calling it on a campaign that is already running schedules
   * nothing new, so a double-click on Start cannot produce two tick chains.
   */
  async begin(campaignId: string, userId: string): Promise<CampaignState> {
    if (this.state.campaignId === campaignId && this.state.status === 'running') {
      return this.state;
    }

    this.setState({
      ...this.initialState,
      campaignId,
      userId,
      status: 'running',
      recent: [{ at: new Date().toISOString(), message: 'Run started.' }],
    });

    await this.schedule(0, 'runTick', { campaignId });
    await this.schedule(WATCHDOG_SECONDS, 'watchdog', { campaignId });
    return this.state;
  }

  /**
   * One scheduled slice of work.
   *
   * Everything that can go wrong here has already been narrowed by the
   * engine, which turns a stage failure into a recorded `failed` status. What
   * is left is the genuinely unexpected — and for that the run stops with the
   * reason kept, rather than retrying into the same wall.
   */
  async runTick(payload: { campaignId: string }): Promise<void> {
    const campaignId = payload?.campaignId || this.state.campaignId;
    if (!campaignId) return;

    const ctx = this.context(await this.cacheTtl());
    let result: StepResult;

    try {
      result = await tick(ctx, campaignId);
    } catch (error) {
      const message = String(error);
      this.setState({
        ...this.state,
        status: 'failed',
        error: message.slice(0, 1000),
        recent: this.note(`The run stopped unexpectedly: ${message}`),
        lastTickAt: new Date().toISOString(),
      });

      const campaign = await loadCampaign(ctx, campaignId).catch(() => null);
      if (campaign) {
        await logEvent(ctx, campaign, campaign.stage, 'error', 'The agent tick threw.', {
          error: message,
        }).catch(() => {});
      }
      return;
    }

    await this.syncFrom(ctx, campaignId, result);

    if (result.more) {
      await this.schedule(TICK_DELAY_SECONDS, 'runTick', { campaignId });
    }
  }

  /** Answer a stage that is waiting on a person. */
  async decide(decision: GateDecision): Promise<CampaignState> {
    const campaignId = this.state.campaignId;
    if (!campaignId) return this.state;

    const ctx = this.context();
    const result = await decideGate(ctx, campaignId, decision);
    await this.syncFrom(ctx, campaignId, result);

    if (result.more) {
      this.setState({ ...this.state, status: 'running' });
      await this.schedule(0, 'runTick', { campaignId });
    }

    return this.state;
  }

  /** Stop ticking. The campaign row keeps whatever it has. */
  async pause(): Promise<CampaignState> {
    for (const schedule of await this.getSchedules()) {
      await this.cancelSchedule(schedule.id);
    }
    this.setState({ ...this.state, status: 'paused', recent: this.note('Paused.') });
    return this.state;
  }

  async resume(): Promise<CampaignState> {
    const campaignId = this.state.campaignId;
    if (!campaignId) return this.state;
    this.setState({ ...this.state, status: 'running', recent: this.note('Resumed.') });
    await this.schedule(0, 'runTick', { campaignId });
    return this.state;
  }

  /**
   * Notice a run that has stalled.
   *
   * A run is stalled if it says it is running but nothing has ticked for a
   * while. That should not happen — but "should not happen" is exactly what a
   * long-lived background process needs a check for, because the alternative
   * is a campaign that sits at 40% forever and nobody knows why.
   */
  async watchdog(payload: { campaignId: string }): Promise<void> {
    const campaignId = payload?.campaignId || this.state.campaignId;
    if (!campaignId) return;

    const ctx = this.context();
    const campaign = await loadCampaign(ctx, campaignId);
    if (!campaign) return;

    if (campaign.status === 'running') {
      const idleFor = this.state.lastTickAt
        ? Date.now() - Date.parse(this.state.lastTickAt)
        : Number.POSITIVE_INFINITY;

      if (idleFor > WATCHDOG_SECONDS * 1000) {
        await logEvent(ctx, campaign, campaign.stage, 'warn', 'The run had stalled; restarting it.');
        this.setState({ ...this.state, recent: this.note('Stalled — restarted.') });
        await this.schedule(0, 'runTick', { campaignId });
      }
    }

    const stillGoing = campaign.status === 'running' || campaign.status === 'waiting';
    if (stillGoing) await this.schedule(WATCHDOG_SECONDS, 'watchdog', { campaignId });
  }

  /** Pull the authoritative row into agent state, which pushes it to clients. */
  private async syncFrom(
    ctx: EngineContext,
    campaignId: string,
    result: StepResult,
  ): Promise<void> {
    const campaign = await loadCampaign(ctx, campaignId);

    this.setState({
      ...this.state,
      campaignId,
      userId: campaign?.userId ?? this.state.userId,
      stage: (campaign?.stage as CampaignStage) ?? this.state.stage,
      status: campaign?.status ?? this.state.status,
      waitingOn: result.waitingOn,
      error: campaign?.error ?? '',
      ticks: this.state.ticks + 1,
      lastTickAt: new Date().toISOString(),
      recent: this.note(result.message),
    });
  }

  /** Plain HTTP, for a client that would rather not hold a socket open. */
  async onRequest(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return Response.json(this.state);
    }
    return new Response('Use the RPC methods or a WebSocket.', { status: 405 });
  }
}

/**
 * The Worker wrapper.
 *
 * Only the app talks to this, over a service binding, so the surface is kept
 * to the agent routing the SDK needs for its WebSocket clients.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    return new Response('Campaign agent. Nothing to see here.', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    });
  },
};

export { getAgentByName };
