/**
 * What the run taught us.
 *
 * A pipeline that does the same thing badly a hundred times is not an agent,
 * it is a cron job. Reflection is the cheapest possible version of the
 * difference: when a run ends, look at what actually happened — what was
 * found, what was ruled out and why, what failed — and write down the parts
 * that would change how the next one goes.
 *
 * Two kinds of output, deliberately kept apart:
 *
 *   Lessons become memories. Specific, scoped, cheap, reversible. "Cafés in
 *   this region almost all use the same template, so a redesign is an easy
 *   sell and a weak differentiator."
 *
 *   A pattern becomes a skill. Rarer, and only when the same judgement would
 *   apply every time, because a skill is an instruction the agent will follow
 *   rather than a note it will consider. Under the default policy the skill
 *   is written as a proposal and does nothing at all until it is approved.
 *
 * The reflection prompt is given the run's own log and nothing else. It is
 * not given the ability to conclude that the outreach cap is too low, or that
 * robots.txt is inconvenient — `FORBIDDEN_PATTERNS` in `skills.ts` catches
 * that if it tries, and this file does not ask.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import {
  campaignEvents,
  prospects,
  type Campaign,
  type MemoryKind,
  type MemoryScope,
  type SelfImproveMode,
} from '../db/schema';
import { trackedGenerateJson, type AiUsageContext } from '../ai/usage';
import { remember, type MemoryContext } from './memory';
import { saveSkill } from './skills';

export interface ReflectionDraft {
  lessons: Array<{
    content: string;
    kind?: MemoryKind;
    scope?: MemoryScope;
    scopeKey?: string;
    tags?: string[];
  }>;
  skill?: {
    name: string;
    description?: string;
    whenToUse: string;
    instructions: string;
    slug?: string;
    stages?: string[];
    tags?: string[];
    rationale?: string;
  } | null;
}

export interface ReflectionOutcome {
  ok: boolean;
  lessonsWritten: number;
  skillSlug: string;
  skillStatus: 'active' | 'proposed' | 'none';
  summary: string;
  error: string;
}

export interface ReflectOptions {
  db: Db;
  ai: Ai;
  campaign: Campaign;
  memory: MemoryContext;
  usage: AiUsageContext;
  selfImprove: SelfImproveMode;
}

const SYSTEM = `You are reviewing a finished run of a growth pipeline and deciding what is worth remembering.

Write down only what would change how the next run goes. Nothing that is already obvious from the run log, nothing that is true of every run, nothing that flatters the process.

Prefer narrow scopes. A lesson about one trade in one region is worth more than a platitude about small businesses.

Return JSON only:
{
  "lessons": [
    { "content": "one sentence", "kind": "fact|lesson|preference|outcome",
      "scope": "global|niche|region|campaign", "scope_key": "the trade or region", "tags": ["..."] }
  ],
  "skill": null
}

Set "skill" to an object only when the run revealed a piece of judgement that should be applied every single time — not a fact, a way of working:
{ "name": "...", "description": "one line", "when_to_use": "one line",
  "instructions": "markdown, under 300 words", "stages": ["shortlist"], "tags": ["..."], "rationale": "why" }

At most four lessons. Usually no skill.`;

export async function reflectOnRun(options: ReflectOptions): Promise<ReflectionOutcome> {
  const { campaign, db } = options;

  const log = await runSummary(db, campaign);
  if (!log.trim()) {
    return {
      ok: false,
      lessonsWritten: 0,
      skillSlug: '',
      skillStatus: 'none',
      summary: '',
      error: 'Nothing happened in this run worth reflecting on.',
    };
  }

  const result = await trackedGenerateJson<Record<string, unknown>>(
    options.ai,
    {
      system: SYSTEM,
      prompt: log,
      maxTokens: 900,
      temperature: 0.4,
    },
    { ...options.usage, operation: 'reflect' },
  );

  if (!result.ok) {
    return {
      ok: false,
      lessonsWritten: 0,
      skillSlug: '',
      skillStatus: 'none',
      summary: '',
      error: result.error,
    };
  }

  const draft = normaliseDraft(result.data);
  let written = 0;

  for (const lesson of draft.lessons.slice(0, 4)) {
    const stored = await remember(options.memory, {
      content: lesson.content,
      kind: lesson.kind ?? 'lesson',
      scope: lesson.scope ?? 'campaign',
      scopeKey: lesson.scopeKey || defaultScopeKey(lesson.scope, campaign),
      tags: lesson.tags,
      source: 'reflection',
      campaignId: campaign.id,
      confidence: 55,
    });
    if (stored) written++;
  }

  let skillSlug = '';
  let skillStatus: ReflectionOutcome['skillStatus'] = 'none';

  if (draft.skill && options.selfImprove !== 'off') {
    const saved = await saveSkill(db, {
      userId: campaign.userId,
      author: 'agent',
      name: draft.skill.name,
      description: draft.skill.description ?? '',
      whenToUse: draft.skill.whenToUse,
      instructions: draft.skill.instructions,
      slug: draft.skill.slug,
      stages: draft.skill.stages,
      tags: draft.skill.tags,
      rationale: draft.skill.rationale ?? `Written after the "${campaign.name || campaign.niche}" run.`,
      status: options.selfImprove === 'auto' ? 'active' : 'proposed',
      note: 'Written by reflection at the end of a run.',
    });

    if (saved.ok && saved.skill) {
      skillSlug = saved.skill.slug;
      skillStatus = saved.skill.status === 'active' ? 'active' : 'proposed';
    }
  }

  const summary = [
    written ? `${written} lesson${written === 1 ? '' : 's'} remembered` : 'nothing new remembered',
    skillSlug
      ? `and a skill ${skillStatus === 'active' ? 'written' : 'proposed'}: "${skillSlug}"`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { ok: true, lessonsWritten: written, skillSlug, skillStatus, summary, error: '' };
}

/**
 * The run, as a page of text.
 *
 * Decisions and failures, plus the shape of the outcome. Not every info line:
 * a hundred "assessed X" rows say nothing a count does not, and they would
 * crowd out the four lines that actually explain the run.
 */
export async function runSummary(db: Db, campaign: Campaign): Promise<string> {
  const events = await db
    .select()
    .from(campaignEvents)
    .where(eq(campaignEvents.campaignId, campaign.id))
    .orderBy(desc(campaignEvents.createdAt))
    .limit(120);

  const interesting = events
    .filter((event) => event.level !== 'info')
    .slice(0, 30)
    .reverse()
    .map((event) => `- [${event.stage}/${event.level}] ${event.message}`);

  const top = await db
    .select({
      name: prospects.businessName,
      score: prospects.score,
      presence: prospects.presenceScore,
      fit: prospects.fitScore,
      scale: prospects.scaleScore,
      status: prospects.status,
      signal: prospects.signal,
    })
    .from(prospects)
    .where(and(eq(prospects.campaignId, campaign.id), eq(prospects.selected, true)))
    .orderBy(desc(prospects.score))
    .limit(10);

  const prospectLines = top.map(
    (row) =>
      `- ${row.name}: score ${row.score} (need ${row.presence}, fit ${row.fit}, scale ${row.scale}), ${row.signal}, ${row.status}`,
  );

  return [
    `Run: ${campaign.name || campaign.niche}`,
    `Trade: ${campaign.niche}. Region: ${campaign.region}, ${campaign.country}.`,
    campaign.idealClient ? `Wanted: ${campaign.idealClient}` : '',
    `Outcome: ${campaign.status} at stage ${campaign.stage}.`,
    `Found ${campaign.discoveredCount}, shortlisted ${campaign.shortlistedCount}, researched ${campaign.enrichedCount}, planned ${campaign.plannedCount}, built ${campaign.builtCount}, proposed ${campaign.proposedCount}.`,
    campaign.error ? `Error: ${campaign.error}` : '',
    prospectLines.length ? `\nWho was pursued:\n${prospectLines.join('\n')}` : '',
    interesting.length ? `\nWhat happened:\n${interesting.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function defaultScopeKey(scope: MemoryScope | undefined, campaign: Campaign): string {
  switch (scope) {
    case 'niche':
      return campaign.niche;
    case 'region':
      return campaign.region;
    case 'campaign':
      return campaign.id;
    default:
      return '';
  }
}

/** Read the model's JSON defensively; it is a suggestion, not a contract. */
export function normaliseDraft(raw: unknown): ReflectionDraft {
  const body = (raw ?? {}) as Record<string, unknown>;
  const lessonsRaw = Array.isArray(body.lessons) ? body.lessons : [];

  const lessons = lessonsRaw
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const content = typeof row.content === 'string' ? row.content.trim() : '';
      if (content.length < 12) return null;

      return {
        content,
        kind: asKind(row.kind),
        scope: asScope(row.scope),
        scopeKey: typeof row.scope_key === 'string' ? row.scope_key : '',
        tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)).slice(0, 8) : [],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const skillRaw = body.skill;
  let skill: ReflectionDraft['skill'] = null;

  if (skillRaw && typeof skillRaw === 'object') {
    const row = skillRaw as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const instructions = typeof row.instructions === 'string' ? row.instructions.trim() : '';
    const whenToUse = typeof row.when_to_use === 'string' ? row.when_to_use.trim() : '';

    if (name && instructions.length > 20 && whenToUse) {
      skill = {
        name,
        description: typeof row.description === 'string' ? row.description : '',
        whenToUse,
        instructions,
        slug: typeof row.slug === 'string' ? row.slug : undefined,
        stages: Array.isArray(row.stages) ? row.stages.map((s) => String(s)) : [],
        tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
        rationale: typeof row.rationale === 'string' ? row.rationale : '',
      };
    }
  }

  return { lessons, skill };
}

function asKind(value: unknown): MemoryKind {
  return value === 'lesson' || value === 'preference' || value === 'outcome' || value === 'fact'
    ? value
    : 'lesson';
}

function asScope(value: unknown): MemoryScope {
  return value === 'global' || value === 'niche' || value === 'region' || value === 'campaign' || value === 'prospect'
    ? value
    : 'campaign';
}
