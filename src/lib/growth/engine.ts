/**
 * The stage machine.
 *
 * One campaign moves through seven stages. This file knows how to do one
 * unit of work and what to do next; the Durable Object in `workers/agent`
 * knows when to call it and how to survive a restart. Keeping the two apart
 * means the pipeline logic is ordinary code that can be read, reasoned about
 * and tested without a Worker runtime.
 *
 * A unit of work is deliberately small — one prospect crawled, one plan
 * written, one site built. A Durable Object gets a bounded slice of CPU per
 * invocation, and a stage that tried to crawl twenty sites in one go would
 * be killed halfway with no record of where it got to. Small units mean a
 * run that is interrupted resumes exactly where it stopped.
 *
 * Every stage ends by consulting the policy: carry on, ask the model, or
 * stop and wait for a person.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import {
  brandKits,
  campaignEvents,
  campaigns,
  demoSites,
  designPlans,
  proposals,
  prospectArtifacts,
  prospects,
  settings,
  type Campaign,
  type CampaignStage,
  type Prospect,
} from '../db/schema';
import { newId, newToken } from '../id';
import { describeError } from '../errors';
import { trackedGenerate, type AiUsageContext } from '../ai/usage';
import { browserConfig, readPage, robotsPermits, screenshot } from '../agent/browser';
import {
  buildToolContext,
  loadAgentSettings,
  type AgentEnvironment,
  type AgentSettingsView,
} from '../agent/context';
import { recall, reinforce, renderMemories, type MemoryContext } from '../agent/memory';
import { noteSkillSuccess, noteSkillUse, renderSkills, selectSkills } from '../agent/skills';
import { reflectOnRun } from '../agent/reflect';
import { countResearchToday, createResearch, firstSentences, runResearch } from '../agent/research';
import { applyOverrides, briefFromKit, type Brief } from './brief';
import { auditSite, combineScores, type SiteAudit } from './assess';
import { crawlSite } from './crawl';
import {
  discover,
  discoveryUserAgent,
  type DiscoveredBusiness,
  type ReviewQuote,
} from './discovery/index';
import { enrichProspect } from './enrich';
import { normaliseDomain } from './html';
import { assessScale, type ScaleAssessment } from './scale';
import { checkProminence, EMPTY_PROMINENCE, type SearchProviderName } from './search';
import {
  nextStage,
  resolvePolicy,
  STAGE_DESCRIPTIONS,
  type StageMode,
  type StagePolicy,
} from './policy';
import type { PromptOverrides } from './prompts';
import {
  ALLOWED_SECTION_TYPES,
  draftDesignPlan,
  draftStyleSpec,
  normalisePlan,
  qualifyProspect,
  shortlistProspects,
  type DesignPlanDraft,
  type PlanSection,
} from './qualify';
import { draftProposal, sendOutreach } from './proposal';
import { renderDemoFiles, type DemoContext } from './render';
import {
  DEFAULT_PROFILE_OPTIONS,
  matchProfiles,
  mergeProfiles,
  profileReferences,
  type ReferenceProfile,
} from './reference';
import {
  deriveFromProfiles,
  deserialiseStyle,
  flowFromProfiles,
  serialiseStyle,
  styleFromBrief,
  type StyleSpec,
} from './style';
import { renderAstroProject } from './project';
import { assembleImagery, type SourceImage } from './imagery';
import { allocateSubdomain, createDnsRecord, demoPublicUrl, publishDemo } from './publish';
import { prospectPrefix, putObject } from './storage';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export interface EngineContext {
  db: Db;
  bucket: R2Bucket;
  ai: Ai;
  env: Env;
  /** Where this app lives, for building links and identifying the crawler. */
  appUrl: string;
  /**
   * Hours an identical model request may be reused. Read from settings by the
   * caller so a stage does not have to fetch it on every call.
   */
  aiCacheTtlHours?: number;
  /**
   * The user's edited system prompts, where they have any. Read by the caller
   * for the same reason: a tick makes several calls and they all want these.
   * Absent means every prompt runs on its default.
   */
  prompts?: PromptOverrides;
  /**
   * How much the agent is allowed to do for itself: browse, remember, write
   * its own skills. Loaded once per tick by the caller when it has it, and
   * lazily here when it does not, so the engine stays callable from a test
   * with three fields filled in.
   */
  agent?: AgentSettingsView;
  /**
   * Skills and memories already looked up during this tick.
   *
   * A tick runs several units of work and the shortlist stage would otherwise
   * repeat the same recall for every business it assesses. The context is
   * rebuilt per tick, so this cache cannot go stale within a run.
   */
  guidanceCache?: Map<string, StageGuidance>;
}

export interface StepResult {
  /** True when there is more to do and the caller should tick again. */
  more: boolean;
  /** Set when the run has stopped and is waiting on a person. */
  waitingOn: CampaignStage | null;
  /** Set when the run is finished, for good or ill. */
  finished: boolean;
  /** One line for the live view. */
  message: string;
}

/** How long one tick may spend before handing control back. */
export const TICK_BUDGET_MS = 15_000;

/**
 * Where a model call's cost is booked.
 *
 * Built per call rather than held on the context, because the useful grouping
 * is by stage, operation and prospect — and those change within a single tick.
 */
function usageFor(
  ctx: EngineContext,
  campaign: Campaign,
  operation: string,
  stage: string,
  prospectId?: string,
): AiUsageContext {
  return {
    db: ctx.db,
    userId: campaign.userId,
    operation,
    stage,
    campaignId: campaign.id,
    prospectId: prospectId ?? null,
    cacheTtlHours: ctx.aiCacheTtlHours,
  };
}

/* ------------------------------------------------------------------ */
/* The agent's own faculties                                           */
/* ------------------------------------------------------------------ */

/**
 * The agent settings, fetched at most once per context.
 *
 * A tick touches several stages' worth of helpers and every one of them wants
 * to know whether memory is on. Caching it on the context makes that one read
 * rather than a dozen, and a context that was handed the settings already —
 * which is what the Durable Object does — never reads at all.
 */
async function agentSettings(ctx: EngineContext, userId: string): Promise<AgentSettingsView> {
  if (!ctx.agent) ctx.agent = await loadAgentSettings(ctx.db, userId);
  return ctx.agent;
}

/** The engine context, in the shape the agent library expects. */
function environmentOf(ctx: EngineContext): AgentEnvironment {
  return { db: ctx.db, ai: ctx.ai, bucket: ctx.bucket, env: ctx.env, appUrl: ctx.appUrl };
}

function memoryContextOf(
  ctx: EngineContext,
  campaign: Campaign,
  settings: AgentSettingsView,
  operation: string,
): MemoryContext {
  return {
    db: ctx.db,
    userId: campaign.userId,
    ai: ctx.ai,
    usage: usageFor(ctx, campaign, operation, 'memory'),
    enabled: settings.memoryEnabled,
  };
}

export interface StageGuidance {
  /** Rendered skills and memories, for the system prompt. */
  text: string;
  skillIds: string[];
  skillSlugs: string[];
  memoryIds: string[];
}

export const NO_GUIDANCE: StageGuidance = { text: '', skillIds: [], skillSlugs: [], memoryIds: [] };

/**
 * What the agent knows that bears on this piece of work.
 *
 * Called at the top of every stage that asks a model anything. Two sources:
 * skills, which are instructions somebody wrote or approved, and memories,
 * which are notes from earlier runs. Both are matched against a plain
 * description of the task, so a stage working on a physiotherapist in
 * Wellington gets what is known about physiotherapists and about Wellington
 * and nothing about the coffee run last month.
 *
 * Failing soft matters here more than usual: this is an enhancement to a
 * pipeline that worked without it, and an agent that cannot recall anything
 * should draft a slightly worse email, not stop.
 */
async function guidanceFor(
  ctx: EngineContext,
  campaign: Campaign,
  stage: CampaignStage,
  task: string,
  prospect?: Prospect,
): Promise<StageGuidance> {
  const cacheKey = `${stage}:${prospect?.id ?? ''}`;
  if (!ctx.guidanceCache) ctx.guidanceCache = new Map();
  const cached = ctx.guidanceCache.get(cacheKey);
  if (cached) return cached;

  try {
    const settings = await agentSettings(ctx, campaign.userId);
    const parts: string[] = [];
    const skillIds: string[] = [];
    const skillSlugs: string[] = [];
    const memoryIds: string[] = [];

    if (settings.skillsEnabled) {
      const skills = await selectSkills(ctx.db, campaign.userId, { stage, task, limit: 3 });
      if (skills.length) {
        parts.push(renderSkills(skills));
        skillIds.push(...skills.map((skill) => skill.id));
        skillSlugs.push(...skills.map((skill) => skill.slug));
        await noteSkillUse(ctx.db, skillIds);
      }
    }

    if (settings.memoryEnabled) {
      const memories = await recall(memoryContextOf(ctx, campaign, settings, 'recall'), {
        query: task,
        scopes: [
          { scope: 'niche', key: campaign.niche },
          { scope: 'region', key: campaign.region },
          { scope: 'campaign', key: campaign.id },
          { scope: 'prospect', key: prospect?.id ?? '' },
        ],
        limit: 6,
      });

      if (memories.length) {
        parts.push(renderMemories(memories));
        memoryIds.push(...memories.map((entry) => entry.memory.id));
        await reinforce(ctx.db, memoryIds);
      }
    }

    const guidance: StageGuidance = {
      text: parts.join('\n\n'),
      skillIds,
      skillSlugs,
      memoryIds,
    };
    ctx.guidanceCache.set(cacheKey, guidance);
    return guidance;
  } catch {
    return NO_GUIDANCE;
  }
}

/**
 * A description of the work in hand, for matching skills and memories.
 *
 * Plain words rather than ids: the thing being matched against is a sentence
 * somebody wrote about when a skill applies, and "plan a site for a
 * physiotherapist in Lower Hutt" shares words with that in a way a ULID never
 * will.
 */
function taskDescription(campaign: Campaign, stage: CampaignStage, prospect?: Prospect): string {
  return [
    STAGE_DESCRIPTIONS[stage],
    prospect ? prospect.businessName : '',
    campaign.niche,
    campaign.region,
    campaign.country,
    campaign.idealClient,
    prospect?.signal ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Read a prospect's site in a real browser when the crawl came back thin.
 *
 * This is the single highest-value use of the browser in the whole pipeline.
 * A crawler that fetches a client-rendered site sees a shell: no words, no
 * headings, no evidence. Everything downstream then treats a business with a
 * perfectly decent site as one with nothing at all — the audit says "thin
 * content", the angle is written about a problem they do not have, and the
 * email that lands is wrong in a way they will notice immediately.
 *
 * Returns null when the fetch was fine, when no browser is configured, or
 * when rendering found no more than fetching did.
 */
async function lookHarder(
  ctx: EngineContext,
  campaign: Campaign,
  prospect: Prospect,
  siteContent: string,
): Promise<{ text: string; note: string } | null> {
  const settings = await agentSettings(ctx, campaign.userId);
  if (settings.browserMode === 'off' || !prospect.website) return null;

  const config = browserConfig(ctx.env);
  if (!config) return null;

  const fetchedWords = siteContent.trim() ? siteContent.trim().split(/\s+/).length : 0;
  if (settings.browserMode === 'fallback' && fetchedWords >= 120) return null;

  const page = await readPage(prospect.website, {
    mode: 'always',
    config,
    crawl: { userAgent: discoveryUserAgent(ctx.appUrl) },
  });

  if (page.via !== 'browser' || page.extracted.wordCount <= fetchedWords) return null;

  return {
    text: page.extracted.text,
    note: `Their site draws itself with JavaScript: a plain fetch saw ${fetchedWords} words, a browser saw ${page.extracted.wordCount}.`,
  };
}

/**
 * Keep a picture of their site as it is today.
 *
 * The before shot. It is the most persuasive thing in a proposal and the one
 * artefact that cannot be recovered later — by the time anybody wants it,
 * they may have changed the site, which is after all what we asked them to
 * do.
 */
async function captureSite(
  ctx: EngineContext,
  campaign: Campaign,
  prospect: Prospect,
): Promise<boolean> {
  const settings = await agentSettings(ctx, campaign.userId);
  if (settings.browserMode === 'off' || !prospect.website) return false;

  const config = browserConfig(ctx.env);
  if (!config) return false;

  // The same robots.txt that governs the crawl governs this: a picture of a
  // page we were asked not to fetch is a page we fetched.
  if (!(await robotsPermits(prospect.website, discoveryUserAgent(ctx.appUrl)))) return false;

  const shot = await screenshot(config, prospect.website, { fullPage: true });
  if (!shot.ok || !shot.data) return false;

  const prefix = prospectPrefix(campaign.userId, campaign.id, prospect.id);
  const stored = await putObject(
    ctx.bucket,
    `${prefix}/shots/before.png`,
    shot.data.bytes,
    shot.data.contentType,
    { source: prospect.website, label: 'Their site today' },
  );

  await ctx.db.insert(prospectArtifacts).values({
    id: newId(),
    userId: campaign.userId,
    prospectId: prospect.id,
    campaignId: campaign.id,
    kind: 'image',
    label: 'Their site today',
    sourceUrl: prospect.website,
    r2Key: stored.key,
    contentType: stored.contentType,
    bytes: stored.bytes,
    meta: JSON.stringify({ capturedBy: 'browser', fullPage: true }),
    createdAt: new Date().toISOString(),
  });

  return true;
}

/**
 * Send the agent to find out about one business.
 *
 * Only under `ai` on the enrich stage, and only within the daily cap: this is
 * the expensive path — several model turns and several page loads per
 * prospect — and it should be a decision somebody made rather than something
 * that quietly happens to eighty businesses.
 *
 * What it is actually for is the things a crawl cannot see: whether they have
 * just changed hands, whether the reviews say something the site does not,
 * whether somebody else in town already does what they do better.
 */
async function researchProspect(
  ctx: EngineContext,
  campaign: Campaign,
  prospect: Prospect,
): Promise<{ id: string; answer: string } | null> {
  const settings = await agentSettings(ctx, campaign.userId);

  const startedToday = await countResearchToday(ctx.db, campaign.userId, 'enrich');
  if (startedToday >= settings.researchDailyCap) {
    await logEvent(
      ctx,
      campaign,
      'enrich',
      'warn',
      `The daily research cap of ${settings.researchDailyCap} is spent, so ${prospect.businessName} was researched from their site alone.`,
      {},
      prospect.id,
    );
    return null;
  }

  const research = await createResearch(ctx.db, {
    userId: campaign.userId,
    campaignId: campaign.id,
    prospectId: prospect.id,
    origin: 'enrich',
    subject: `${prospect.businessName}, a ${campaign.niche} in ${prospect.region || campaign.region}${prospect.website ? ` — ${prospect.website}` : ''}`,
    question:
      'What should I know about this business before designing them a speculative one-page site? ' +
      'Who they are, who they serve, anything recent, and anything about them that a redesign should keep.',
    // Deliberately smaller than a hand-started task: this runs per prospect,
    // unattended, and four tool calls is enough to check a site and a search.
    stepBudget: Math.min(settings.stepBudget, 5),
  });

  const finished = await runResearch({
    environment: environmentOf(ctx),
    researchId: research.id,
  });

  if (!finished?.answer) return null;
  return { id: finished.id, answer: finished.answer };
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export async function logEvent(
  ctx: EngineContext,
  campaign: Pick<Campaign, 'id' | 'userId'>,
  stage: string,
  level: 'info' | 'decision' | 'warn' | 'error',
  message: string,
  detail: Record<string, unknown> = {},
  prospectId?: string,
): Promise<void> {
  await ctx.db.insert(campaignEvents).values({
    id: newId(),
    campaignId: campaign.id,
    userId: campaign.userId,
    prospectId: prospectId ?? null,
    stage,
    level,
    message: message.slice(0, 1000),
    detail: JSON.stringify(detail).slice(0, 8000),
    createdAt: new Date().toISOString(),
  });
}

async function touch(ctx: EngineContext, campaignId: string, patch: Partial<Campaign>): Promise<void> {
  const now = new Date().toISOString();
  await ctx.db
    .update(campaigns)
    .set({ ...patch, lastActivityAt: now, updatedAt: now })
    .where(eq(campaigns.id, campaignId));
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export async function loadCampaign(ctx: EngineContext, id: string): Promise<Campaign | null> {
  const rows = await ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function resolveBrief(ctx: EngineContext, campaign: Campaign): Promise<Brief> {
  let kit = null;

  if (campaign.brandKitId) {
    const rows = await ctx.db
      .select()
      .from(brandKits)
      .where(eq(brandKits.id, campaign.brandKitId))
      .limit(1);
    kit = rows[0] ?? null;
  }

  if (!kit) {
    const rows = await ctx.db
      .select()
      .from(brandKits)
      .where(and(eq(brandKits.userId, campaign.userId), eq(brandKits.isDefault, true)))
      .limit(1);
    kit = rows[0] ?? null;
  }

  const brief = applyOverrides(briefFromKit(kit), campaign.briefOverrides);

  // The cache on the kit is keyed by URL and allowed to be a superset — an
  // edited reference list leaves the old measurements behind, and a run that
  // added its own references writes into the same place. So what the brief
  // carries is the subset matching the references it actually names, in their
  // order.
  return { ...brief, referenceProfiles: matchProfiles(brief.references, brief.referenceProfiles).profiles };
}

/**
 * Measure any reference site we have not measured yet, and cache the result.
 *
 * Runs at the brief stage, once per campaign, before anything is planned.
 * Fetching is bounded and every failure is contained in the profile it
 * belongs to, so a reference that has gone offline costs a log line rather
 * than a run. Nothing here is on the hot path of a prospect.
 */
async function profileBriefReferences(
  ctx: EngineContext,
  campaign: Campaign,
  brief: Brief,
): Promise<Brief> {
  const { profiles, missing } = matchProfiles(brief.references, brief.referenceProfiles);
  if (!missing.length) return { ...brief, referenceProfiles: profiles };

  const fresh = await profileReferences(missing, DEFAULT_PROFILE_OPTIONS);
  const read = fresh.filter((profile) => profile.ok);
  const failed = fresh.filter((profile) => !profile.ok);

  if (read.length) {
    await logEvent(
      ctx,
      campaign,
      'brief',
      'info',
      `Read ${read.length} reference site${read.length === 1 ? '' : 's'} for their type, colour and proportions.`,
      {
        references: read.map((profile) => ({
          url: profile.url,
          faces: profile.faces.slice(0, 2).map((face) => face.family),
          colours: profile.colours.slice(0, 4).map((colour) => colour.value),
          radii: profile.radiiPx.slice(0, 3),
        })),
      },
    );
  }

  for (const profile of failed) {
    await logEvent(
      ctx,
      campaign,
      'brief',
      'warn',
      `Could not read the reference ${profile.url}: ${profile.error}. The demos will fall back to the saved direction for anything it would have decided.`,
    );
  }

  // Cached on the kit so the next campaign against the same direction does
  // not refetch. A campaign with no kit has nowhere to put it and simply
  // measures again next time, which is once per run.
  if (brief.brandKitId) {
    const merged = mergeProfiles(brief.referenceProfiles, fresh);
    await ctx.db
      .update(brandKits)
      .set({
        referenceProfiles: JSON.stringify(merged),
        referenceProfiledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(brandKits.id, brief.brandKitId));
  }

  return withReferenceFlow({ ...brief, referenceProfiles: [...profiles, ...fresh] });
}

/**
 * Take the section order from the references, where they agree on one.
 *
 * "Every demo has the same flow" was the literal truth: `sectionOrder` came
 * off the kit and defaulted to one built-in list, so every page in every run
 * marched hero → intro → services → gallery → testimonials → about →
 * location → contact. A reference site's own order is the single best signal
 * of the order the designer is actually after, and it is measured rather than
 * guessed.
 *
 * Only applied when the references yield a real sequence; four is the floor
 * for calling it a page shape rather than two landmarks and a footer. The
 * plan model can still depart from it per business — it is a preference, not
 * a schedule.
 */
function withReferenceFlow(brief: Brief): Brief {
  const flow = flowFromProfiles(brief.referenceProfiles, ALLOWED_SECTION_TYPES);
  return flow.length >= 4 ? { ...brief, sectionOrder: flow } : brief;
}

/**
 * How many photographs of theirs the crawl actually found.
 *
 * The styler needs it: a layout built around frames is the wrong answer for a
 * business with two usable pictures, and "mostly photographs" is how a demo
 * ends up with generated imagery carrying the page.
 */
async function countProspectImages(ctx: EngineContext, prospectId: string): Promise<number> {
  const rows = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(prospectArtifacts)
    .where(and(eq(prospectArtifacts.prospectId, prospectId), eq(prospectArtifacts.kind, 'image')));

  return Number(rows[0]?.count ?? 0);
}

/**
 * The style spec a prospect starts from: the kit, moved by the references.
 *
 * Shared by the plan stage (which then lets the model move it again) and by
 * the build stage (which needs the same floor when a plan predates styling).
 */
function baseStyle(brief: Brief): StyleSpec {
  return deriveFromProfiles(styleFromBrief(brief), brief.referenceProfiles);
}

export async function resolvePolicyFor(
  ctx: EngineContext,
  campaign: Campaign,
): Promise<StagePolicy> {
  const rows = await ctx.db
    .select({ growthPolicy: settings.growthPolicy })
    .from(settings)
    .where(eq(settings.userId, campaign.userId))
    .limit(1);
  return resolvePolicy(campaign.policy, rows[0]?.growthPolicy);
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

/**
 * Do as much work as fits in one budget, then report.
 *
 * The loop exists so a stage with twenty small units does not need twenty
 * round trips through the scheduler, while the budget makes sure control
 * comes back before the runtime takes it away.
 */
export async function tick(ctx: EngineContext, campaignId: string): Promise<StepResult> {
  const deadline = Date.now() + TICK_BUDGET_MS;
  let last: StepResult = { more: false, waitingOn: null, finished: false, message: 'Nothing to do.' };

  while (Date.now() < deadline) {
    last = await step(ctx, campaignId);
    if (!last.more) return last;
  }

  return { ...last, more: true };
}

/** One unit of work. */
export async function step(ctx: EngineContext, campaignId: string): Promise<StepResult> {
  const campaign = await loadCampaign(ctx, campaignId);
  if (!campaign) {
    return { more: false, waitingOn: null, finished: true, message: 'Campaign not found.' };
  }

  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    return { more: false, waitingOn: null, finished: true, message: `Run is ${campaign.status}.` };
  }
  if (campaign.status === 'waiting') {
    return {
      more: false,
      waitingOn: (campaign.waitingOn as CampaignStage) ?? campaign.stage,
      finished: false,
      message: 'Waiting for a decision.',
    };
  }
  if (campaign.status === 'complete' || campaign.status === 'failed') {
    return { more: false, waitingOn: null, finished: true, message: `Run is ${campaign.status}.` };
  }

  const policy = await resolvePolicyFor(ctx, campaign);

  try {
    switch (campaign.stage) {
      case 'brief':
        return await stageBrief(ctx, campaign, policy);
      case 'discover':
        return await stageDiscover(ctx, campaign, policy);
      case 'shortlist':
        return await stageShortlist(ctx, campaign, policy);
      case 'enrich':
        return await stageEnrich(ctx, campaign, policy);
      case 'plan':
        return await stagePlan(ctx, campaign, policy);
      case 'build':
        return await stageBuild(ctx, campaign, policy);
      case 'propose':
        return await stagePropose(ctx, campaign, policy);
      default:
        return await finish(ctx, campaign, 'Nothing left to do.');
    }
  } catch (error) {
    const message = describeError(error);
    await logEvent(ctx, campaign, campaign.stage, 'error', 'The stage threw.', { error: message });
    await touch(ctx, campaign.id, {
      status: 'failed',
      error: message.slice(0, 2000),
      completedAt: new Date().toISOString(),
    });
    return { more: false, waitingOn: null, finished: true, message: `Failed: ${message}` };
  }
}

/**
 * A stage has finished its work. Either move on, or stop and ask.
 */
async function advance(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
  message: string,
): Promise<StepResult> {
  const mode = policy[campaign.stage];
  const following = nextStage(campaign.stage);

  if (mode === 'manual') {
    await touch(ctx, campaign.id, { status: 'waiting', waitingOn: campaign.stage });
    await logEvent(ctx, campaign, campaign.stage, 'info', `${message} Waiting for you.`);
    return { more: false, waitingOn: campaign.stage, finished: false, message };
  }

  if (!following) return await finish(ctx, campaign, message);

  await touch(ctx, campaign.id, { stage: following, waitingOn: null });
  await logEvent(ctx, campaign, campaign.stage, 'info', `${message} Moving to ${following}.`);
  return { more: true, waitingOn: null, finished: false, message };
}

async function finish(ctx: EngineContext, campaign: Campaign, message: string): Promise<StepResult> {
  await touch(ctx, campaign.id, {
    status: 'complete',
    waitingOn: null,
    completedAt: new Date().toISOString(),
  });
  await logEvent(ctx, campaign, campaign.stage, 'info', `Run complete. ${message}`);
  await reflect(ctx, campaign);
  return { more: false, waitingOn: null, finished: true, message: `Complete. ${message}` };
}

/**
 * Look back at the run and keep what is worth keeping.
 *
 * The one moment in the whole pipeline where the agent gets better rather
 * than merely finishing. It runs at the end of a completed run only — a run
 * that failed halfway has nothing to teach that its error message does not
 * already say — and it is wrapped in a try/catch because a reflection that
 * throws must not turn a finished campaign into a failed one.
 */
async function reflect(ctx: EngineContext, campaign: Campaign): Promise<void> {
  try {
    const settings = await agentSettings(ctx, campaign.userId);
    if (!settings.memoryEnabled && settings.selfImprove === 'off') return;

    // A run that never got as far as looking at anybody has nothing to say.
    if (campaign.discoveredCount === 0) return;

    const current = (await loadCampaign(ctx, campaign.id)) ?? campaign;

    const outcome = await reflectOnRun({
      db: ctx.db,
      ai: ctx.ai,
      campaign: current,
      memory: memoryContextOf(ctx, current, settings, 'reflect'),
      usage: usageFor(ctx, current, 'reflect', current.stage),
      selfImprove: settings.selfImprove,
    });

    if (!outcome.ok) {
      await logEvent(ctx, current, current.stage, 'info', `Nothing was learned from this run: ${outcome.error}`);
      return;
    }

    await logEvent(ctx, current, current.stage, 'decision', `Looking back: ${outcome.summary}.`, {
      lessons: outcome.lessonsWritten,
      skill: outcome.skillSlug,
      skillStatus: outcome.skillStatus,
    });

    // Skills that were loaded during a run that reached the end have earned a
    // point. Crude, and better than nothing at telling a skill that works
    // from one that merely exists.
    const used = [...(ctx.guidanceCache?.values() ?? [])].flatMap((entry) => entry.skillIds);
    if (used.length) await noteSkillSuccess(ctx.db, [...new Set(used)]);
  } catch (error) {
    await logEvent(ctx, campaign, campaign.stage, 'warn', `Reflection failed: ${String(error).slice(0, 300)}`).catch(
      () => {},
    );
  }
}

/* ------------------------------------------------------------------ */
/* Stage: brief                                                        */
/* ------------------------------------------------------------------ */

async function stageBrief(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const brief = await profileBriefReferences(ctx, campaign, await resolveBrief(ctx, campaign));
  const style = baseStyle(brief);

  await logEvent(ctx, campaign, 'brief', 'info', `Building against the "${brief.name}" direction.`, {
    typefaces: style.typography.map((t) => t.family),
    palette: style.palette.map((c) => c.value),
    references: brief.references.length,
    referencesRead: brief.referenceProfiles.filter((profile) => profile.ok).length,
  });

  if (style.source === 'references') {
    await logEvent(ctx, campaign, 'brief', 'decision', style.rationale, {
      typefaces: style.typography.map((t) => t.family),
      palette: style.palette.map((c) => c.value),
    });
  } else if (brief.references.length === 0) {
    await logEvent(
      ctx,
      campaign,
      'brief',
      'info',
      'This direction has no reference sites, so the demos are built from the saved palette, ' +
        'type and rules alone. Adding a couple of sites you want the work to feel like is the ' +
        'single biggest thing that stops a run looking like one template.',
    );
  }

  if (policy.brief === 'ai') {
    // Let the model adapt the direction to the trade, without letting it
    // replace the designer's rules — it may only add a sentence of context.
    const result = await trackedGenerate(
      ctx.ai,
      {
        system:
          'You adapt a designer\'s existing art direction to one trade. Add at most two sentences ' +
          'of specific guidance for this trade: what the photography should show, what a customer ' +
          'is looking for when they land. Never contradict or replace the direction you are given. ' +
          'Return the sentences only, no preamble.',
        prompt: `Direction: ${brief.direction}\n\nTrade: ${campaign.niche}\nRegion: ${campaign.region}`,
        maxTokens: 250,
        temperature: 0.6,
      },
      usageFor(ctx, campaign, 'brief', 'brief'),
    );

    if (result.ok) {
      const merged = { ...JSON.parse(campaign.briefOverrides || '{}') } as Record<string, unknown>;
      merged.direction = `${brief.direction}\n\nFor ${campaign.niche}: ${result.data}`;
      await touch(ctx, campaign.id, { briefOverrides: JSON.stringify(merged) });
      await logEvent(ctx, campaign, 'brief', 'decision', 'Adapted the direction to the trade.', {
        added: result.data,
      });
    }
  }

  return await advance(ctx, campaign, policy, 'Brief resolved.');
}

/* ------------------------------------------------------------------ */
/* Stage: discover                                                     */
/* ------------------------------------------------------------------ */

async function stageDiscover(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const existing = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(prospects)
    .where(eq(prospects.campaignId, campaign.id));

  if ((existing[0]?.count ?? 0) > 0) {
    return await advance(ctx, campaign, policy, 'Already discovered.');
  }

  // Look at more than the target: most of what comes back will not be worth
  // pursuing, and a shortlist can only choose from what it was shown.
  const limit = Math.min(Math.max(campaign.targetCount * 4, 20), 120);

  const result = await discover(campaign.discoveryProvider, {
    niche: campaign.niche,
    region: campaign.region,
    country: campaign.country,
    limit,
    manualInput: campaign.manualInput,
    apiKey: ctx.env.GOOGLE_PLACES_API_KEY,
    userAgent: discoveryUserAgent(ctx.appUrl),
  });

  if (!result.ok) {
    await logEvent(ctx, campaign, 'discover', 'error', result.error);
    await touch(ctx, campaign.id, {
      status: 'failed',
      error: result.error.slice(0, 2000),
      completedAt: new Date().toISOString(),
    });
    return { more: false, waitingOn: null, finished: true, message: result.error };
  }

  for (const note of result.data.notes) {
    await logEvent(ctx, campaign, 'discover', 'info', note);
  }

  const now = new Date().toISOString();
  const seenDomains = new Set<string>();
  let inserted = 0;

  for (const business of result.data.businesses) {
    const domain = normaliseDomain(business.website ?? '');
    // One row per domain: chains list every branch and they all share a site.
    if (domain && seenDomains.has(domain)) continue;
    if (domain) seenDomains.add(domain);

    await ctx.db.insert(prospects).values({
      id: newId(),
      userId: campaign.userId,
      campaignId: campaign.id,
      businessName: business.name.slice(0, 200),
      niche: campaign.niche,
      region: campaign.region,
      country: campaign.country,
      website: (business.website ?? '').slice(0, 500),
      domain,
      email: (business.email ?? '').slice(0, 320).toLowerCase(),
      phone: (business.phone ?? '').slice(0, 50),
      address: (business.address ?? '').slice(0, 500),
      mapsUrl: (business.mapsUrl ?? '').slice(0, 500),
      socialLinks: '[]',
      source: business.source,
      sourceRef: business.sourceRef.slice(0, 200),
      rating: business.rating ?? null,
      reviewCount: business.reviewCount ?? 0,
      brand: (business.brand ?? '').slice(0, 200),
      branchCount: Math.max(1, business.branchCount ?? 1),
      findings: JSON.stringify({
        context: business.context ?? '',
        brandWikidata: business.brandWikidata ?? '',
        operator: business.operator ?? '',
        // Carried, not fetched. Research redeems these for the handful of
        // prospects that make the shortlist; downloading photography for
        // forty businesses to discard thirty of them is paying for pictures
        // nobody will see.
        photoRefs: business.photoRefs ?? [],
        reviews: business.reviews ?? [],
        openingHours: business.openingHours ?? [],
        directorySummary: business.summary ?? '',
      }),
      stage: 'discover',
      status: 'new',
      createdAt: now,
      updatedAt: now,
    });
    inserted++;
  }

  await touch(ctx, campaign.id, { discoveredCount: inserted, startedAt: campaign.startedAt ?? now });
  await logEvent(
    ctx,
    campaign,
    'discover',
    'info',
    `Found ${inserted} business${inserted === 1 ? '' : 'es'} via ${campaign.discoveryProvider}.`,
  );

  if (inserted === 0) {
    await touch(ctx, campaign.id, {
      status: 'failed',
      error: 'Discovery returned nothing usable.',
      completedAt: now,
    });
    return { more: false, waitingOn: null, finished: true, message: 'Nothing found.' };
  }

  return await advance(ctx, campaign, policy, `Found ${inserted}.`);
}

/* ------------------------------------------------------------------ */
/* Stage: shortlist                                                    */
/* ------------------------------------------------------------------ */

/**
 * Assess one prospect, then — once all are assessed — choose between them.
 *
 * Assessment is a single-page fetch, not a crawl. At this point we are
 * deciding whether a business is worth an hour of attention; spending six
 * requests on each of eighty businesses to find that out is rude to them and
 * slow for us. The full crawl happens in `enrich`, on the ones that survive.
 */
async function stageShortlist(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const pending = await ctx.db
    .select()
    .from(prospects)
    .where(and(eq(prospects.campaignId, campaign.id), eq(prospects.stage, 'discover')))
    .limit(1);

  const prospect = pending[0];

  if (prospect) {
    await assessProspect(ctx, campaign, prospect);
    return { more: true, waitingOn: null, finished: false, message: `Assessed ${prospect.businessName}.` };
  }

  // Everything is assessed. Now choose.
  const assessed = await ctx.db
    .select()
    .from(prospects)
    .where(and(eq(prospects.campaignId, campaign.id), eq(prospects.stage, 'shortlist')))
    .orderBy(desc(prospects.score));

  // The ceiling is enforced here as well as at assessment: a prospect whose
  // scale was raised by a later lookup must not survive on a stale score.
  const eligible = assessed.filter(
    (p) => p.score >= campaign.scoreFloor && p.scaleScore <= campaign.scaleCeiling,
  );
  const ruledOutOnSize = assessed.filter((p) => p.scaleScore > campaign.scaleCeiling).length;
  const mode = policy.shortlist;

  let chosen: Prospect[] = [];
  let reasoning = '';

  if (mode === 'ai') {
    const guidance = await guidanceFor(
      ctx,
      campaign,
      'shortlist',
      taskDescription(campaign, 'shortlist'),
    );

    const decision = await shortlistProspects(
      ctx.ai,
      eligible.map((p) => ({
        id: p.id,
        businessName: p.businessName,
        score: p.score,
        presenceScore: p.presenceScore,
        fitScore: p.fitScore,
        scaleScore: p.scaleScore,
        signal: p.signal,
        angle: String(readFindings(p).angle ?? ''),
      })),
      campaign.targetCount,
      campaign.idealClient,
      usageFor(ctx, campaign, 'shortlist', 'shortlist'),
      ctx.prompts,
      guidance.text,
    );

    if (decision.ok && decision.data.selectedIds.length) {
      const picked = new Set(decision.data.selectedIds);
      chosen = eligible.filter((p) => picked.has(p.id));
      reasoning = decision.data.reasoning;
    } else {
      // A model that will not answer should not stop the run; fall back to
      // the ranking, and say so rather than passing it off as a choice.
      chosen = eligible.slice(0, campaign.targetCount);
      reasoning = decision.ok
        ? 'The model selected nothing, so the top of the ranking was taken instead.'
        : `The model could not choose (${decision.error}), so the top of the ranking was taken.`;
    }
  } else {
    // `auto` and `manual` both pre-select on the ranking. Under `manual` this
    // is a suggestion the user is about to see and can change.
    chosen = eligible.slice(0, campaign.targetCount);
    reasoning = `Top ${chosen.length} by score, above the floor of ${campaign.scoreFloor}.`;
  }

  const chosenIds = new Set(chosen.map((p) => p.id));
  const now = new Date().toISOString();

  for (const candidate of assessed) {
    const selected = chosenIds.has(candidate.id);
    await ctx.db
      .update(prospects)
      .set({
        selected,
        selectedBy: selected ? (mode === 'ai' ? 'ai' : 'auto') : null,
        status: selected ? 'qualified' : 'rejected',
        updatedAt: now,
      })
      .where(eq(prospects.id, candidate.id));
  }

  await touch(ctx, campaign.id, { shortlistedCount: chosen.length });
  await logEvent(
    ctx,
    campaign,
    'shortlist',
    mode === 'ai' ? 'decision' : 'info',
    `Shortlisted ${chosen.length} of ${assessed.length}` +
      (ruledOutOnSize ? `, with ${ruledOutOnSize} ruled out on size.` : '.'),
    { reasoning, selected: chosen.map((p) => p.businessName), ruledOutOnSize },
  );

  if (chosen.length === 0) {
    await touch(ctx, campaign.id, {
      status: 'complete',
      completedAt: now,
      error: '',
    });
    await logEvent(
      ctx,
      campaign,
      'shortlist',
      'warn',
      ruledOutOnSize === assessed.length
        ? `Every business found was too large (scale ceiling ${campaign.scaleCeiling}). This niche in this region is chains. Try a smaller town, or raise the ceiling if you want to approach them anyway.`
        : `Nothing cleared the score floor of ${campaign.scoreFloor}. Lower it, or try another niche.`,
    );
    return { more: false, waitingOn: null, finished: true, message: 'Nothing worth pursuing.' };
  }

  return await advance(ctx, campaign, policy, `Shortlisted ${chosen.length}.`);
}

/** Audit one prospect's site and ask the model whether they are worth it. */
async function assessProspect(
  ctx: EngineContext,
  campaign: Campaign,
  prospect: Prospect,
): Promise<void> {
  const now = new Date().toISOString();
  const findings = readFindings(prospect);

  const crawl = prospect.website
    ? await crawlSite(prospect.website, {
        userAgent: discoveryUserAgent(ctx.appUrl),
        maxPages: 1,
      })
    : null;

  const audit = auditSite(
    {
      name: prospect.businessName,
      website: prospect.website || undefined,
      mapsUrl: prospect.mapsUrl || undefined,
      reviewCount: prospect.reviewCount,
    },
    crawl,
  );

  /**
   * How large are they already? Measured before the model is asked anything,
   * because this is the question the model was worst at and the one that
   * decides whether a cold concept site is welcome or an imposition.
   */
  const scale = assessScale(
    {
      name: prospect.businessName,
      brand: prospect.brand || undefined,
      brandWikidata: String(findings.brandWikidata ?? '') || undefined,
      operator: String(findings.operator ?? '') || undefined,
      branchCount: prospect.branchCount,
      reviewCount: prospect.reviewCount,
    },
    crawl,
  );

  /**
   * Look them up outside their own site — but only when the measured signals
   * have not already settled it. A lookup on a business we have conclusive
   * evidence about is a request nobody needed to make.
   */
  const prominence = scale.decisive
    ? EMPTY_PROMINENCE
    : await checkProminence(prospect.businessName, {
        userAgent: discoveryUserAgent(ctx.appUrl),
        region: campaign.region,
        provider: (ctx.env.SEARCH_PROVIDER as SearchProviderName) ?? 'none',
        apiKey: ctx.env.SEARCH_API_KEY,
      });

  // A catalogued entity is the same class of evidence as a brand:wikidata tag.
  if (prominence.wikidataId) {
    scale.score = Math.min(100, scale.score + 45);
    scale.decisive = true;
    scale.signals.push({
      id: 'wikidata',
      label: 'Catalogued on Wikidata — a business somebody thought notable',
      weight: 45,
      hit: true,
      detail: `${prominence.wikidataId}: ${prominence.wikidataDescription}`,
    });
    scale.summary = `${prospect.businessName} has a Wikidata entry (${prominence.wikidataDescription || 'catalogued entity'}). Too well known for a cold concept site.`;
  }

  const siteSummary = crawl?.pages[0]?.extracted.text.slice(0, 3000) ?? '';

  const overCeiling = scale.score > campaign.scaleCeiling;

  /**
   * Do not spend a model call on a business the measurements have already
   * ruled out. This is the single largest saving in the stage — a run over a
   * high street full of chain branches used to pay to be told so one at a
   * time.
   */
  const guidance = overCeiling
    ? NO_GUIDANCE
    : await guidanceFor(ctx, campaign, 'shortlist', taskDescription(campaign, 'shortlist'));

  const qualification = overCeiling
    ? null
    : await qualifyProspect(ctx.ai, {
        businessName: prospect.businessName,
        niche: campaign.niche,
        idealClient: campaign.idealClient,
        region: campaign.region,
        audit,
        scale,
        prominence,
        siteSummary,
        context: String(findings.context ?? ''),
        guidance: guidance.text,
        usage: usageFor(ctx, campaign, 'qualify', 'shortlist', prospect.id),
        prompts: ctx.prompts,
      });

  const fitScore = qualification?.ok ? qualification.data.fitScore : 0;
  const skip = overCeiling || (qualification?.ok === true && qualification.data.skip);

  /**
   * A failed qualification is not a judgement of zero, and must not read like
   * one.
   *
   * `fit 0` on every line of a run log looks like the model being harsh. It is
   * indistinguishable, in the log, from the model call failing for every
   * prospect — and when that happens the shortlist falls back to ranking on
   * need alone, which selects exactly the businesses with no website and
   * therefore nothing to build a page from. Say so, loudly, once per prospect.
   */
  if (qualification && !qualification.ok) {
    await logEvent(
      ctx,
      campaign,
      'shortlist',
      'warn',
      `Could not judge fit for ${prospect.businessName} (${qualification.error}). ` +
        'Scored 0, which ranks it on need alone — check the AI page if this is happening to every prospect.',
      {},
      prospect.id,
    );
  }

  const reasoning = overCeiling
    ? scale.summary
    : qualification?.ok
      ? qualification.data.reasoning
      : (qualification?.error ?? '');

  await ctx.db
    .update(prospects)
    .set({
      stage: 'shortlist',
      signal: audit.signal,
      presenceScore: audit.presenceScore,
      fitScore,
      scaleScore: scale.score,
      scale: JSON.stringify(scale).slice(0, 20_000),
      brand: scale.brand.slice(0, 200),
      // A prospect the measurements or the model rule out is ranked to the
      // bottom rather than deleted, so the decision stays visible and can be
      // overridden from the shortlist gate.
      score: skip ? 0 : combineScores(audit.presenceScore, fitScore),
      audit: JSON.stringify(audit).slice(0, 20_000),
      findings: JSON.stringify({
        ...findings,
        angle: qualification?.ok ? qualification.data.angle : '',
        reasoning,
        objective: qualification?.ok ? qualification.data.objective : 'conversion',
        skip,
        tooBig: overCeiling || (qualification?.ok === true && qualification.data.tooBig),
        prominence: prominence.checked.length ? prominence : undefined,
      }).slice(0, 20_000),
      notes: overCeiling ? scale.summary : qualification?.ok ? qualification.data.angle : '',
      domain: prospect.domain || normaliseDomain(prospect.website),
      socialLinks: JSON.stringify(crawl?.socials ?? []),
      email: prospect.email || crawl?.emails[0] || '',
      updatedAt: now,
    })
    .where(eq(prospects.id, prospect.id));

  await logEvent(
    ctx,
    campaign,
    'shortlist',
    overCeiling ? 'decision' : 'info',
    overCeiling
      ? `${prospect.businessName}: ruled out on size (scale ${scale.score}, ceiling ${campaign.scaleCeiling}). ${scale.summary}`
      : `${prospect.businessName}: need ${audit.presenceScore}, fit ${fitScore}, scale ${scale.score}${skip ? ' — skip' : ''}.`,
    { summary: audit.summary, scale: scale.summary, modelCalled: !overCeiling },
    prospect.id,
  );
}

/* ------------------------------------------------------------------ */
/* Stage: enrich                                                       */
/* ------------------------------------------------------------------ */

async function stageEnrich(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const pending = await selectedAtStage(ctx, campaign, 'shortlist', 1);
  const prospect = pending[0];

  if (!prospect) {
    const done = await countAtStage(ctx, campaign, 'enrich');
    await touch(ctx, campaign.id, { enrichedCount: done });
    return await advance(ctx, campaign, policy, `Researched ${done}.`);
  }

  const prefix = prospectPrefix(campaign.userId, campaign.id, prospect.id);
  const carried = readFindings(prospect);
  const enrichment = await enrichProspect(
    ctx.bucket,
    prefix,
    {
      name: prospect.businessName,
      website: prospect.website || undefined,
      email: prospect.email || undefined,
      phone: prospect.phone || undefined,
      rating: prospect.rating ?? undefined,
      reviewCount: prospect.reviewCount || undefined,
      reviews: readReviewQuotes(carried.reviews),
      openingHours: readStringList(carried.openingHours, 7),
      summary: String(carried.directorySummary ?? ''),
    },
    {
      userAgent: discoveryUserAgent(ctx.appUrl),
      photoRefs: readStringList(carried.photoRefs, 8),
      placesApiKey: ctx.env.GOOGLE_PLACES_API_KEY,
    },
  );

  const now = new Date().toISOString();

  for (const [index, page] of enrichment.pageObjects.entries()) {
    await ctx.db.insert(prospectArtifacts).values({
      id: newId(),
      userId: campaign.userId,
      prospectId: prospect.id,
      campaignId: campaign.id,
      kind: 'page',
      label: enrichment.crawl.pages[index]?.extracted.title.slice(0, 200) ?? `Page ${index + 1}`,
      sourceUrl: enrichment.crawl.pages[index]?.finalUrl ?? '',
      r2Key: page.key,
      contentType: page.contentType,
      bytes: page.bytes,
      meta: JSON.stringify({
        wordCount: enrichment.crawl.pages[index]?.extracted.wordCount ?? 0,
        headings: enrichment.crawl.pages[index]?.extracted.headings.slice(0, 12) ?? [],
      }),
      createdAt: now,
    });
  }

  for (const image of enrichment.imageObjects) {
    await ctx.db.insert(prospectArtifacts).values({
      id: newId(),
      userId: campaign.userId,
      prospectId: prospect.id,
      campaignId: campaign.id,
      kind: 'image',
      label: '',
      sourceUrl: image.sourceUrl,
      r2Key: image.key,
      contentType: image.contentType,
      bytes: image.bytes,
      meta: '{}',
      createdAt: now,
    });
  }

  // Re-audit with everything the full crawl saw. The one-page audit that got
  // this prospect shortlisted was a sample; this is the real picture.
  const audit = auditSite(
    {
      name: prospect.businessName,
      website: prospect.website || undefined,
      mapsUrl: prospect.mapsUrl || undefined,
      reviewCount: enrichment.reviewCount,
    },
    enrichment.crawl,
  );

  const findings = readFindings(prospect);

  /**
   * Everything above is the crawl, which is cheap and sometimes wrong about
   * the same sites every time. What follows is the agent looking properly:
   * rendering the page when the fetch saw nothing, keeping a picture of it,
   * and — when this stage is set to `ai` — going and finding out what a crawl
   * cannot tell you. All three fail soft, because a run that stops because a
   * screenshot service was busy is a worse pipeline than one that does not
   * have screenshots.
   */
  let siteContent = enrichment.siteContent;
  const agentNotes: string[] = [];

  try {
    const rendered = await lookHarder(ctx, campaign, prospect, siteContent);
    if (rendered) {
      siteContent = rendered.text;
      agentNotes.push(rendered.note);
      await logEvent(ctx, campaign, 'enrich', 'info', rendered.note, {}, prospect.id);
    }
  } catch (error) {
    agentNotes.push(`The browser could not read their site: ${String(error).slice(0, 200)}`);
  }

  let captured = false;
  try {
    captured = await captureSite(ctx, campaign, prospect);
  } catch {
    // A missing screenshot is a missing screenshot.
  }

  let research: { id: string; answer: string } | null = null;
  if (policy.enrich === 'ai') {
    try {
      research = await researchProspect(ctx, campaign, prospect);
      if (research) {
        await logEvent(
          ctx,
          campaign,
          'enrich',
          'decision',
          `Researched ${prospect.businessName} beyond their site: ${firstSentences(research.answer, 1)}`,
          { researchId: research.id },
          prospect.id,
        );
      }
    } catch (error) {
      await logEvent(
        ctx,
        campaign,
        'enrich',
        'warn',
        `Research on ${prospect.businessName} did not finish: ${String(error).slice(0, 200)}`,
        {},
        prospect.id,
      );
    }
  }

  await ctx.db
    .update(prospects)
    .set({
      stage: 'enrich',
      enrichedAt: now,
      email: enrichment.contact.email || prospect.email,
      phone: enrichment.contact.phone || prospect.phone,
      contactName: enrichment.contact.name.slice(0, 120),
      contactRole: enrichment.contact.role.slice(0, 120),
      domain: enrichment.domain || prospect.domain,
      socialLinks: JSON.stringify(enrichment.socials).slice(0, 4000),
      rating: enrichment.rating,
      reviewCount: enrichment.reviewCount,
      reviewSummary: enrichment.reviewSummary.slice(0, 2000),
      presenceScore: audit.presenceScore,
      score: combineScores(audit.presenceScore, prospect.fitScore),
      signal: audit.signal,
      audit: JSON.stringify(audit).slice(0, 20_000),
      findings: JSON.stringify({
        ...findings,
        openingHours: enrichment.openingHours,
        siteContent: siteContent.slice(0, 12_000),
        directoryContent: enrichment.directoryContent.slice(0, 6000),
        researchNotes: [...enrichment.notes, ...agentNotes],
        research: research?.answer.slice(0, 4000) ?? '',
        researchId: research?.id ?? '',
        screenshot: captured,
        // The references have been redeemed; the bytes are in R2 and the rows
        // are in `prospect_artifacts`. Keeping them would be carrying an
        // expired handle around in a column.
        photoRefs: [],
      }).slice(0, 40_000),
      updatedAt: now,
    })
    .where(eq(prospects.id, prospect.id));

  await logEvent(
    ctx,
    campaign,
    'enrich',
    'info',
    `Researched ${prospect.businessName}: ${enrichment.crawl.pages.length} page(s), ` +
      `${enrichment.imageObjects.length} image(s), ${enrichment.contact.email ? 'email found' : 'no email'}` +
      `${enrichment.reviewSummary ? ', reviews to quote' : ''}` +
      `${captured ? ', screenshot kept' : ''}.`,
    {
      notes: [...enrichment.notes, ...agentNotes],
      socials: enrichment.socials.map((s) => s.platform),
      researchId: research?.id ?? '',
    },
    prospect.id,
  );

  return { more: true, waitingOn: null, finished: false, message: `Researched ${prospect.businessName}.` };
}

/* ------------------------------------------------------------------ */
/* Stage: plan                                                         */
/* ------------------------------------------------------------------ */

async function stagePlan(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const pending = await selectedAtStage(ctx, campaign, 'enrich', 1);
  const prospect = pending[0];

  if (!prospect) {
    const done = await countAtStage(ctx, campaign, 'plan');
    await touch(ctx, campaign.id, { plannedCount: done });
    return await advance(ctx, campaign, policy, `Planned ${done}.`);
  }

  const brief = await resolveBrief(ctx, campaign);
  const findings = readFindings(prospect);
  const audit = readAudit(prospect);
  const now = new Date().toISOString();

  const guidance = await guidanceFor(
    ctx,
    campaign,
    'plan',
    taskDescription(campaign, 'plan', prospect),
    prospect,
  );

  const planInput = {
    businessName: prospect.businessName,
    niche: campaign.niche,
    region: campaign.region,
    brief,
    audit,
    objective: (findings.objective as 'conversion') ?? 'conversion',
    angle: String(findings.angle ?? ''),
    siteContent: String(findings.siteContent ?? ''),
    directoryContent: String(findings.directoryContent ?? ''),
    research: String(findings.research ?? ''),
    contact: { email: prospect.email, phone: prospect.phone, address: prospect.address },
    facts: {
      category: String(findings.context ?? ''),
      address: prospect.address,
      openingHours: Array.isArray(findings.openingHours)
        ? (findings.openingHours as unknown[]).map(String).slice(0, 7)
        : [],
      rating: prospect.rating ?? null,
      reviewCount: prospect.reviewCount ?? 0,
      reviewSummary: prospect.reviewSummary ?? '',
      hasWebsite: Boolean(prospect.website),
    },
    guidance: guidance.text,
    usage: usageFor(ctx, campaign, 'plan', 'plan', prospect.id),
    prompts: ctx.prompts,
  };

  let draft: DesignPlanDraft;
  /**
   * Why this plan is not the model's.
   *
   * Recorded rather than only logged. A scaffolded plan is a near-empty page,
   * and a run where half the demos were scaffolded looks exactly like a run
   * where the generator is bland — from the outside they are the same
   * complaint. Stored on the row, it is countable.
   */
  let fallbackReason = '';

  if (policy.plan === 'auto') {
    // `auto` skips the model entirely and lays out what we already know.
    // Cheap, instant, and honest about being a scaffold.
    draft = scaffoldPlan(planInput.businessName, campaign.niche, campaign.region, brief, prospect);
    fallbackReason = 'The plan stage is set to "Just do it", which lays out known facts without asking a model.';
    await logEvent(ctx, campaign, 'plan', 'info', `Scaffolded a plan for ${prospect.businessName}.`, {}, prospect.id);
  } else {
    const result = await draftDesignPlan(ctx.ai, planInput);
    if (!result.ok) {
      draft = scaffoldPlan(planInput.businessName, campaign.niche, campaign.region, brief, prospect);
      fallbackReason = `The model could not plan this page: ${result.error}`;
      await logEvent(
        ctx,
        campaign,
        'plan',
        'warn',
        `The model could not plan ${prospect.businessName} (${result.error}); using a scaffold. ` +
          'A scaffolded page carries only the facts already held, so it will read thinner than the rest of the run.',
        {},
        prospect.id,
      );
    } else {
      draft = result.data;
      await logEvent(
        ctx,
        campaign,
        'plan',
        'decision',
        `Planned ${prospect.businessName}: ${draft.summary}`,
        { objective: draft.objective, sections: draft.sections.map((s) => s.type) },
        prospect.id,
      );
    }
  }

  /**
   * The look, decided for this one business.
   *
   * A separate call from the plan above, and deliberately so: one call asked
   * for the design and every word of the copy would truncate, and truncation
   * is what used to turn a page into three headings. This one returns a few
   * dozen numbers, and whatever it returns is clamped back into ranges that
   * are guaranteed to lay out — so the worst case is the page the references
   * would have produced anyway.
   */
  let style = baseStyle(brief);

  if (policy.plan !== 'auto') {
    const styled = await draftStyleSpec(ctx.ai, {
      businessName: prospect.businessName,
      niche: campaign.niche,
      region: campaign.region,
      brief,
      base: style,
      audit,
      objective: (findings.objective as 'conversion') ?? 'conversion',
      angle: String(findings.angle ?? ''),
      siteContent: String(findings.siteContent ?? ''),
      facts: planInput.facts,
      imageCount: await countProspectImages(ctx, prospect.id),
      guidance: guidance.text,
      usage: usageFor(ctx, campaign, 'plan', 'style', prospect.id),
      prompts: ctx.prompts,
    });

    if (styled.ok) {
      style = styled.data;
      await logEvent(
        ctx,
        campaign,
        'plan',
        'decision',
        `Styled ${prospect.businessName}: ${style.rationale}`,
        {
          palette: style.palette.map((c) => c.value),
          typefaces: style.typography.map((t) => t.family),
          composition: style.composition,
        },
        prospect.id,
      );
    } else {
      await logEvent(
        ctx,
        campaign,
        'plan',
        'warn',
        `Could not style ${prospect.businessName} (${styled.error}); using the direction as measured.`,
        { source: style.source },
        prospect.id,
      );
    }
  }

  await ctx.db.insert(designPlans).values({
    id: newId(),
    userId: campaign.userId,
    prospectId: prospect.id,
    campaignId: campaign.id,
    brandKitId: brief.brandKitId,
    summary: draft.summary.slice(0, 400),
    strategy: draft.strategy.slice(0, 2000),
    objective: draft.objective,
    palette: JSON.stringify(style.palette),
    typography: JSON.stringify(style.typography),
    sections: JSON.stringify(draft.sections).slice(0, 60_000),
    meta: JSON.stringify(draft.meta),
    style: serialiseStyle(style).slice(0, 20_000),
    model: policy.plan === 'auto' ? 'scaffold' : 'workers-ai',
    fallbackReason: fallbackReason.slice(0, 400),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db
    .update(prospects)
    .set({ stage: 'plan', plannedAt: now, updatedAt: now })
    .where(eq(prospects.id, prospect.id));

  return { more: true, waitingOn: null, finished: false, message: `Planned ${prospect.businessName}.` };
}

/** A usable plan without asking a model anything. */
function scaffoldPlan(
  businessName: string,
  niche: string,
  region: string,
  brief: Brief,
  prospect: Prospect,
): DesignPlanDraft {
  const findings = readFindings(prospect);
  const hours = readStringList(findings.openingHours, 7);
  const reviews = readReviewQuotes(findings.reviews);
  const where = prospect.address || region;

  const sections: PlanSection[] = [
    {
      id: 'hero',
      type: 'hero',
      /**
       * Not the business name. The name is in the header and the footer
       * already, and a first screen that only repeats it is the failure the
       * plan prompt names first — so the scaffold must not commit it either.
       */
      heading: `${sentenceCase(niche)} in ${region}`,
      subheading: businessName,
      body: describeBusiness(businessName, niche, where, prospect),
      items: [],
      cta: { label: 'Get in touch', href: '#contact' },
      imageHint: `A wide photograph of ${businessName} — the room, the counter, or the work itself.`,
      notes: 'Scaffolded without a model, from what is already known.',
    },
  ];

  if (reviews.length) {
    sections.push({
      id: 'testimonials',
      type: 'testimonials',
      heading: 'What people say',
      subheading: prospect.rating
        ? `Rated ${prospect.rating}${prospect.reviewCount ? ` across ${prospect.reviewCount} reviews` : ''}`
        : '',
      body: '',
      items: reviews.slice(0, 3).map((review) => ({
        title: review.author || 'A customer',
        body: review.quote,
      })),
      cta: null,
      imageHint: '',
      notes: 'Their own reviews, quoted as written.',
    });
  }

  if (hours.length || where) {
    sections.push({
      id: 'location',
      type: 'location',
      heading: hours.length ? 'Where and when' : 'Where to find us',
      subheading: where,
      body: '',
      items: hours.map((entry) => ({ title: entry, body: '' })),
      cta: null,
      imageHint: where ? `The shopfront at ${where}, seen from the street.` : '',
      notes: '',
    });
  }

  sections.push({
    id: 'contact',
    type: 'contact',
    heading: 'Get in touch',
    subheading: '',
    body: [prospect.phone, prospect.email, where].filter(Boolean).join(' · '),
    items: [],
    cta: prospect.email
      ? { label: 'Email us', href: `mailto:${prospect.email}` }
      : prospect.phone
        ? { label: 'Call us', href: `tel:${prospect.phone.replace(/[^+\d]/g, '')}` }
        : null,
    imageHint: '',
    notes: '',
  });

  const ordered = brief.sectionOrder.length
    ? sections.sort(
        (a, b) =>
          indexOrLast(brief.sectionOrder, a.type) - indexOrLast(brief.sectionOrder, b.type),
      )
    : sections;

  return {
    summary: `A one-page site for ${businessName}, laid out from what is already known about them.`,
    strategy:
      'Written without a model, so every line on it is a fact already held rather than copy. ' +
      'The structure is sound; the voice is not there yet.',
    objective: 'conversion',
    sections: ordered,
    meta: {
      title: `${businessName} — ${niche} in ${region}`,
      description: describeBusiness(businessName, niche, where, prospect).slice(0, 200),
    },
  };
}

/**
 * One true sentence about the business.
 *
 * The scaffold used to emit a hero with the name on it, an "About" heading
 * with nothing under it and an empty contact block — three headings and no
 * page. When the model fails, this is what a stranger sees, so it has to be
 * made of the facts we actually hold rather than left blank for someone to
 * fill in later.
 */
function describeBusiness(
  businessName: string,
  niche: string,
  where: string,
  prospect: Pick<Prospect, 'rating' | 'reviewCount'>,
): string {
  const standing =
    prospect.rating && prospect.reviewCount
      ? `Rated ${prospect.rating} across ${prospect.reviewCount} reviews.`
      : '';

  return [
    where ? `${businessName} is a ${niche.toLowerCase()} in ${where}.` : `${businessName} is a ${niche.toLowerCase()}.`,
    standing,
  ]
    .filter(Boolean)
    .join(' ');
}

/** "coffee roasters" → "Coffee roasters". Leaves an already-capped word alone. */
function sentenceCase(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}

function indexOrLast(order: string[], type: string): number {
  const index = order.indexOf(type);
  return index === -1 ? order.length : index;
}

/* ------------------------------------------------------------------ */
/* Stage: build                                                        */
/* ------------------------------------------------------------------ */

async function stageBuild(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const pending = await selectedAtStage(ctx, campaign, 'plan', 1);
  const prospect = pending[0];

  if (!prospect) {
    const done = await countAtStage(ctx, campaign, 'build');
    await touch(ctx, campaign.id, { builtCount: done });
    return await advance(ctx, campaign, policy, `Built ${done}.`);
  }

  const now = new Date().toISOString();
  const planRows = await ctx.db
    .select()
    .from(designPlans)
    .where(eq(designPlans.prospectId, prospect.id))
    .orderBy(desc(designPlans.createdAt))
    .limit(1);

  const plan = planRows[0];
  if (!plan) {
    await ctx.db.update(prospects).set({ stage: 'build', updatedAt: now }).where(eq(prospects.id, prospect.id));
    await logEvent(ctx, campaign, 'build', 'warn', `No plan for ${prospect.businessName}; skipped.`, {}, prospect.id);
    return { more: true, waitingOn: null, finished: false, message: 'Skipped, no plan.' };
  }

  const audit = readAudit(prospect);

  // Under `ai`, the model's own judgement about whether there is an honest
  // case to make is respected here rather than at the shortlist, because by
  // now there is a real plan to judge.
  if (policy.build === 'ai' && audit.observations.length === 0) {
    await ctx.db.update(prospects).set({ stage: 'build', updatedAt: now }).where(eq(prospects.id, prospect.id));
    await logEvent(
      ctx,
      campaign,
      'build',
      'decision',
      `Skipped ${prospect.businessName}: nothing measurable is wrong with their site, so there is nothing honest to lead with.`,
      {},
      prospect.id,
    );
    return { more: true, waitingOn: null, finished: false, message: 'Skipped, no honest angle.' };
  }

  const brief = await resolveBrief(ctx, campaign);
  /**
   * The look this demo was planned with, not the kit's.
   *
   * Stored on the plan so the page that gets built is the page that was
   * decided — re-deriving it here would quietly discard the model's answer,
   * and a plan written before per-prospect styling existed falls back to what
   * its brief implies.
   */
  const style = deserialiseStyle(plan.style, baseStyle(brief));
  const settingsRow = await loadSettings(ctx, campaign.userId);
  // The saved setting wins; `DEMO_HOST` is the deployment's default for an
  // account that has never opened the settings page. Falling back to a
  // hardcoded host instead would publish demos somewhere the route does not
  // cover, which looks exactly like a hosting failure.
  const demoHost = settingsRow.demoHost || ctx.env.DEMO_HOST || 'demo.jwbsstudio.com';

  const { label, host } = await allocateSubdomain(prospect.businessName, demoHost, async (candidate) => {
    const rows = await ctx.db
      .select({ id: demoSites.id })
      .from(demoSites)
      .where(eq(demoSites.host, candidate))
      .limit(1);
    return rows.length > 0;
  });

  /* -- Photography: theirs first, generated to fill the gaps ------- */

  const imageRows = await ctx.db
    .select()
    .from(prospectArtifacts)
    .where(and(eq(prospectArtifacts.prospectId, prospect.id), eq(prospectArtifacts.kind, 'image')))
    .limit(8);

  const theirs: SourceImage[] = [];
  for (const row of imageRows) {
    const object = await ctx.bucket.get(row.r2Key);
    if (!object) continue;
    theirs.push({
      body: await object.arrayBuffer(),
      contentType: row.contentType || 'image/jpeg',
      sourceUrl: row.sourceUrl,
    });
  }

  const draftForImagery: DesignPlanDraft = {
    summary: plan.summary,
    strategy: plan.strategy,
    objective: plan.objective as DesignPlanDraft['objective'],
    sections: parseJson<PlanSection[]>(plan.sections, []),
    meta: parseJson<{ title: string; description: string }>(plan.meta, {
      title: prospect.businessName,
      description: '',
    }),
  };

  /**
   * Generating photography is the one stage that spends money per picture
   * rather than per prospect, so it is off unless the campaign asked for it.
   * A page with their own three photographs is always better than a page with
   * three of ours.
   */
  const imagery = await assembleImagery(
    ctx.env.AI,
    {
      plan: draftForImagery,
      brief,
      subject: {
        businessName: prospect.businessName,
        niche: campaign.niche,
        region: campaign.region,
      },
      theirs,
      generate: settingsRow.generateDemoImages,
      maxGenerated: settingsRow.maxGeneratedImages,
    },
    {
      db: ctx.db,
      userId: campaign.userId,
      operation: 'imagery',
      stage: 'build',
      campaignId: campaign.id,
      prospectId: prospect.id,
    },
  );

  for (const note of imagery.notes) {
    await logEvent(ctx, campaign, 'build', 'info', note, {}, prospect.id);
  }

  /**
   * A demo with no pictures at all is the one outcome worth interrupting for.
   *
   * It is also invisible otherwise: the build succeeds, the link works, and
   * nothing in the log says the page is a wall of type until someone opens it.
   */
  if (imagery.images.length === 0) {
    await logEvent(
      ctx,
      campaign,
      'build',
      'warn',
      `${prospect.businessName} has no photography — they published none we could use` +
        (settingsRow.generateDemoImages
          ? ' and generation produced none either.'
          : ', and generating placeholders is switched off in Growth settings. ' +
            'The demo is text only.'),
      {},
      prospect.id,
    );
  }

  const images = imagery.images.map((image) => ({
    path: image.path,
    body: image.body,
    contentType: image.contentType,
  }));

  const context: DemoContext = {
    businessName: prospect.businessName,
    niche: campaign.niche,
    region: campaign.region,
    contact: { email: prospect.email, phone: prospect.phone, address: prospect.address },
    socials: parseJson<Array<{ platform: string; url: string }>>(prospect.socialLinks, []),
    images: imagery.images.map((image) => ({
      src: image.path,
      alt: image.alt,
      generated: image.generated,
      sectionId: image.sectionId,
      role: image.role,
    })),
    openingHours: parseJson<string[]>(
      JSON.stringify(readFindings(prospect).openingHours ?? []),
      [],
    ),
    designerName: settingsRow.businessName || settingsRow.outreachSenderName || 'JWBS Studio',
    designerUrl: settingsRow.website || ctx.appUrl,
  };

  const draft = draftForImagery;

  const demoId = newId();
  await ctx.db.insert(demoSites).values({
    id: demoId,
    userId: campaign.userId,
    prospectId: prospect.id,
    campaignId: campaign.id,
    planId: plan.id,
    subdomain: label,
    host,
    status: 'building',
    createdAt: now,
    updatedAt: now,
  });

  try {
    const published = await publishDemo(
      ctx.bucket,
      host,
      renderDemoFiles(draft, brief, context, style),
      renderAstroProject(draft, brief, context, host, style),
      images,
    );

    // Only needed when there is no wildcard record; harmless when there is.
    let dnsRecordId: string | null = null;
    if (ctx.env.CLOUDFLARE_API_TOKEN && ctx.env.CLOUDFLARE_ZONE_ID) {
      const dns = await createDnsRecord(
        ctx.env.CLOUDFLARE_API_TOKEN,
        ctx.env.CLOUDFLARE_ZONE_ID,
        host,
        new URL(ctx.appUrl).hostname,
      );
      if (dns.ok) dnsRecordId = dns.recordId || null;
      else await logEvent(ctx, campaign, 'build', 'warn', `DNS record not created: ${dns.error}`, {}, prospect.id);
    }

    /**
     * Record the address that actually works.
     *
     * The subdomain only once the wildcard has been seen to serve a demo; the
     * path mount on this app's own origin otherwise. Written at build time so
     * a proposal drafted later cannot pick up a link that never resolved.
     */
    const publicUrl = demoPublicUrl(ctx.appUrl, host, settingsRow.demoHostVerified);

    await ctx.db
      .update(demoSites)
      .set({
        status: 'live',
        r2Prefix: published.prefix,
        sourcePrefix: published.sourcePrefix,
        publicUrl,
        fileCount: published.fileCount,
        bytes: published.bytes,
        dnsRecordId,
        publishedAt: now,
        updatedAt: now,
      })
      .where(eq(demoSites.id, demoId));

    await ctx.db
      .update(prospects)
      .set({ stage: 'build', builtAt: now, updatedAt: now })
      .where(eq(prospects.id, prospect.id));

    await logEvent(
      ctx,
      campaign,
      'build',
      'info',
      `Published a demo for ${prospect.businessName} at ${publicUrl}`,
      {
        host,
        publicUrl,
        files: published.fileCount,
        bytes: published.bytes,
        servedFrom: settingsRow.demoHostVerified ? 'subdomain' : 'app origin',
      },
      prospect.id,
    );

    if (!settingsRow.demoHostVerified) {
      await logEvent(
        ctx,
        campaign,
        'build',
        'warn',
        'Demo subdomains have not been verified as reachable, so this is linked on the app itself. ' +
          'Run the hosting check in Growth settings once the wildcard DNS record and Worker route are in place.',
        {},
        prospect.id,
      );
    }
  } catch (error) {
    await ctx.db
      .update(demoSites)
      .set({ status: 'failed', buildError: describeError(error).slice(0, 1000), updatedAt: now })
      .where(eq(demoSites.id, demoId));
    await ctx.db.update(prospects).set({ stage: 'build', updatedAt: now }).where(eq(prospects.id, prospect.id));
    await logEvent(ctx, campaign, 'build', 'error', `Build failed for ${prospect.businessName}: ${error}`, {}, prospect.id);
  }

  return { more: true, waitingOn: null, finished: false, message: `Built ${prospect.businessName}.` };
}

/* ------------------------------------------------------------------ */
/* Stage: propose                                                      */
/* ------------------------------------------------------------------ */

async function stagePropose(
  ctx: EngineContext,
  campaign: Campaign,
  policy: StagePolicy,
): Promise<StepResult> {
  const pending = await selectedAtStage(ctx, campaign, 'build', 1);
  const prospect = pending[0];

  if (!prospect) {
    const done = await countAtStage(ctx, campaign, 'propose');
    await touch(ctx, campaign.id, { proposedCount: done });
    return await advance(ctx, campaign, policy, `Drafted ${done} proposal(s).`);
  }

  const now = new Date().toISOString();
  const settingsRow = await loadSettings(ctx, campaign.userId);
  const brief = await resolveBrief(ctx, campaign);
  const audit = readAudit(prospect);

  const demoRows = await ctx.db
    .select()
    .from(demoSites)
    .where(and(eq(demoSites.prospectId, prospect.id), eq(demoSites.status, 'live')))
    .orderBy(desc(demoSites.createdAt))
    .limit(1);

  const demo = demoRows[0];
  const planRows = await ctx.db
    .select()
    .from(designPlans)
    .where(eq(designPlans.prospectId, prospect.id))
    .orderBy(desc(designPlans.createdAt))
    .limit(1);
  const plan = planRows[0];

  if (!demo || !plan) {
    await ctx.db.update(prospects).set({ stage: 'propose', updatedAt: now }).where(eq(prospects.id, prospect.id));
    await logEvent(ctx, campaign, 'propose', 'warn', `No live demo for ${prospect.businessName}; skipped.`, {}, prospect.id);
    return { more: true, waitingOn: null, finished: false, message: 'Skipped, no demo.' };
  }

  const token = newToken(24);
  // The URL recorded at build time, which is the one known to resolve.
  const demoUrl = demo.publicUrl || `https://${demo.host}`;
  const proposalUrl = `${ctx.appUrl}/proposal/${token}`;

  const guidance = await guidanceFor(
    ctx,
    campaign,
    'propose',
    taskDescription(campaign, 'propose', prospect),
    prospect,
  );

  const draft = await draftProposal(ctx.ai, {
    businessName: prospect.businessName,
    niche: campaign.niche,
    region: campaign.region,
    audit,
    plan: {
      summary: plan.summary,
      strategy: plan.strategy,
      objective: plan.objective as DesignPlanDraft['objective'],
      sections: [],
      meta: { title: '', description: '' },
    },
    demoUrl,
    proposalUrl,
    senderName: settingsRow.outreachSenderName || settingsRow.businessName || 'JWBS Studio',
    senderBio: settingsRow.outreachBio,
    signature: settingsRow.outreachSignature,
    capabilities: brief.capabilities,
    guidance: guidance.text,
    usage: usageFor(ctx, campaign, 'proposal', 'propose', prospect.id),
    prompts: ctx.prompts,
  });

  if (!draft.ok) {
    await ctx.db.update(prospects).set({ stage: 'propose', updatedAt: now }).where(eq(prospects.id, prospect.id));
    await logEvent(ctx, campaign, 'propose', 'error', `Could not draft for ${prospect.businessName}: ${draft.error}`, {}, prospect.id);
    return { more: true, waitingOn: null, finished: false, message: 'Draft failed.' };
  }

  const proposalId = newId();
  await ctx.db.insert(proposals).values({
    id: proposalId,
    userId: campaign.userId,
    prospectId: prospect.id,
    campaignId: campaign.id,
    demoSiteId: demo.id,
    title: `Concept site for ${prospect.businessName}`,
    status: 'draft',
    body: draft.data.pageBody.slice(0, 8000),
    emailSubject: draft.data.subject,
    emailBody: draft.data.body,
    sentTo: prospect.email,
    currency: campaign.country === 'AU' ? 'AUD' : 'NZD',
    publicToken: token,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db
    .update(prospects)
    .set({ stage: 'propose', proposedAt: now, updatedAt: now })
    .where(eq(prospects.id, prospect.id));

  /* -- Sending ---------------------------------------------------- */

  const shouldSend = policy.propose === 'auto' || policy.propose === 'ai';

  if (!shouldSend) {
    await logEvent(
      ctx,
      campaign,
      'propose',
      'info',
      `Drafted an email to ${prospect.businessName}. Not sent — the stage is set to ask you.`,
      { subject: draft.data.subject },
      prospect.id,
    );
    return { more: true, waitingOn: null, finished: false, message: `Drafted for ${prospect.businessName}.` };
  }

  // `ai` will not write to somebody when there is nothing measurable to say.
  if (policy.propose === 'ai' && audit.observations.length === 0) {
    await logEvent(
      ctx,
      campaign,
      'propose',
      'decision',
      `Drafted but did not send to ${prospect.businessName}: there is no verified observation to open with.`,
      {},
      prospect.id,
    );
    return { more: true, waitingOn: null, finished: false, message: 'Held back.' };
  }

  const sentToday = await countSentToday(ctx.db, campaign.userId);
  const outcome = await sendOutreach(
    ctx.env,
    {
      to: prospect.email,
      toName: prospect.contactName || prospect.businessName,
      subject: draft.data.subject,
      body: draft.data.body,
      demoUrl,
      proposalUrl,
      senderName: settingsRow.outreachSenderName || settingsRow.businessName || 'JWBS Studio',
      signature: settingsRow.outreachSignature,
      replyTo: settingsRow.outreachReplyTo || settingsRow.email,
    },
    {
      sentToday,
      dailyCap: settingsRow.outreachDailyCap,
      initiatedByUser: false,
    },
  );

  if (outcome.ok) {
    await ctx.db
      .update(proposals)
      .set({
        status: 'sent',
        sentAt: now,
        sendResult: `${outcome.result.provider}:${outcome.result.id ?? 'ok'}`,
        updatedAt: now,
      })
      .where(eq(proposals.id, proposalId));
    await ctx.db
      .update(prospects)
      .set({ status: 'contacted', updatedAt: now })
      .where(eq(prospects.id, prospect.id));
    await logEvent(ctx, campaign, 'propose', 'info', `Emailed ${prospect.businessName} at ${prospect.email}.`, {}, prospect.id);
  } else {
    await ctx.db
      .update(proposals)
      .set({ sendResult: outcome.error.slice(0, 500), updatedAt: now })
      .where(eq(proposals.id, proposalId));
    await logEvent(
      ctx,
      campaign,
      'propose',
      outcome.capped ? 'warn' : 'error',
      `Not sent to ${prospect.businessName}: ${outcome.error}`,
      {},
      prospect.id,
    );

    // A spent cap stops the stage rather than burning through the rest of
    // the shortlist drafting emails that cannot go out.
    if (outcome.capped) {
      await touch(ctx, campaign.id, { status: 'waiting', waitingOn: 'propose' });
      return { more: false, waitingOn: 'propose', finished: false, message: outcome.error };
    }
  }

  return { more: true, waitingOn: null, finished: false, message: `Proposed to ${prospect.businessName}.` };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function selectedAtStage(
  ctx: EngineContext,
  campaign: Campaign,
  stage: CampaignStage,
  limit: number,
): Promise<Prospect[]> {
  return ctx.db
    .select()
    .from(prospects)
    .where(
      and(
        eq(prospects.campaignId, campaign.id),
        eq(prospects.selected, true),
        eq(prospects.stage, stage),
      ),
    )
    .orderBy(desc(prospects.score))
    .limit(limit);
}

async function countAtStage(
  ctx: EngineContext,
  campaign: Campaign,
  stage: CampaignStage,
): Promise<number> {
  const rows = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(prospects)
    .where(
      and(
        eq(prospects.campaignId, campaign.id),
        eq(prospects.selected, true),
        eq(prospects.stage, stage),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * Emails actually sent in the last 24 hours, across every campaign.
 *
 * Counted from the proposals table rather than from a counter, so the cap
 * survives a restart and cannot be reset by starting a new run.
 */
export async function countSentToday(db: Db, userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(proposals)
    .where(
      and(
        eq(proposals.userId, userId),
        inArray(proposals.status, ['sent', 'viewed', 'accepted', 'declined']),
        gte(proposals.sentAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

async function loadSettings(ctx: EngineContext, userId: string) {
  const rows = await ctx.db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  const row = rows[0];
  if (row) return row;

  // A user provisioned by SQL may have no settings row yet; the run should
  // not die over it.
  return {
    businessName: '',
    website: '',
    email: '',
    demoHost: 'demo.jwbsstudio.com',
    outreachDailyCap: 0,
    outreachSenderName: '',
    outreachBio: '',
    outreachSignature: '',
    outreachReplyTo: '',
  } as unknown as typeof settings.$inferSelect;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readFindings(prospect: Pick<Prospect, 'findings'>): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(prospect.findings, {});
}

/** A list of strings out of `findings`, which is whatever was written there. */
export function readStringList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter(Boolean).slice(0, max)
    : [];
}

/** Review quotes out of `findings`, coerced field by field. */
export function readReviewQuotes(value: unknown): ReviewQuote[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      quote: String(entry.quote ?? '').slice(0, 600),
      rating: Number.isFinite(Number(entry.rating)) ? Number(entry.rating) : null,
      author: String(entry.author ?? '').slice(0, 120),
    }))
    .filter((review) => review.quote)
    .slice(0, 5);
}

export function readAudit(prospect: Pick<Prospect, 'audit' | 'businessName'>): SiteAudit {
  return parseJson<SiteAudit>(prospect.audit, {
    checks: [],
    presenceScore: 0,
    signal: 'other',
    summary: '',
    observations: [],
    context: [],
    platform: null,
    pagesSeen: 0,
    crawledAt: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export type GateDecision =
  | { action: 'proceed' }
  | { action: 'select'; prospectIds: string[] }
  | { action: 'stop' };

/**
 * Answer the question a waiting stage is asking.
 *
 * A selection at the shortlist gate replaces whatever was pre-selected, so
 * the user's choice is the whole answer rather than an addition to the
 * model's.
 */
export async function decideGate(
  ctx: EngineContext,
  campaignId: string,
  decision: GateDecision,
): Promise<StepResult> {
  const campaign = await loadCampaign(ctx, campaignId);
  if (!campaign) {
    return { more: false, waitingOn: null, finished: true, message: 'Campaign not found.' };
  }

  const now = new Date().toISOString();

  if (decision.action === 'stop') {
    await touch(ctx, campaign.id, { status: 'cancelled', waitingOn: null, completedAt: now });
    await logEvent(ctx, campaign, campaign.stage, 'info', 'Stopped here.');
    return { more: false, waitingOn: null, finished: true, message: 'Stopped.' };
  }

  if (decision.action === 'select') {
    const chosen = new Set(decision.prospectIds);
    const all = await ctx.db
      .select({ id: prospects.id })
      .from(prospects)
      .where(eq(prospects.campaignId, campaign.id));

    for (const row of all) {
      const selected = chosen.has(row.id);
      await ctx.db
        .update(prospects)
        .set({
          selected,
          selectedBy: selected ? 'user' : null,
          status: selected ? 'qualified' : 'rejected',
          updatedAt: now,
        })
        .where(eq(prospects.id, row.id));
    }

    await touch(ctx, campaign.id, { shortlistedCount: chosen.size });
    await logEvent(ctx, campaign, campaign.stage, 'decision', `You selected ${chosen.size}.`);
  }

  const following = nextStage(campaign.stage);
  if (!following) return await finish(ctx, campaign, 'Approved at the last stage.');

  await touch(ctx, campaign.id, { stage: following, status: 'running', waitingOn: null });
  await logEvent(ctx, campaign, campaign.stage, 'info', `Approved. Moving to ${following}.`);
  return { more: true, waitingOn: null, finished: false, message: `Moving to ${following}.` };
}
