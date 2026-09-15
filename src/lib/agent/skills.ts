/**
 * Skills: the part of the agent you can edit.
 *
 * A skill is a named piece of instruction — "how to open an outreach email to
 * a trade business", "what to check before calling a site dated" — that gets
 * loaded into a prompt when it is relevant and left out when it is not. That
 * is all. The value is not in the mechanism, it is in what it makes possible:
 * the agent's behaviour becomes a set of documents you can read, change and
 * revert, rather than a paragraph buried in a TypeScript template literal.
 *
 * Two rules make having a lot of them affordable:
 *
 *   Progressive disclosure. Every skill's name and one-line `whenToUse` is
 *   cheap to consider; only the handful that match the task get their full
 *   body pasted in. Fifty skills cost about what three used to.
 *
 *   Versioning. An edit writes the previous body to `agent_skill_revisions`
 *   and bumps the version. When the agent rewrites one of its own skills,
 *   "what changed, when, and why" is a row rather than an archaeology
 *   project.
 *
 * The agent may write skills for itself. What it may not do is edit a locked
 * skill, or write one that tries to talk the pipeline past a safety rule —
 * see `FORBIDDEN_PATTERNS`. Those checks are here rather than in the prompt
 * because a prompt is a request and this is a rule.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import {
  agentSkillRevisions,
  agentSkills,
  type AgentSkill,
  type CampaignStage,
} from '../db/schema';
import { newId } from '../id';
import { keywordOverlap, tokenise } from './memory';

export const MAX_INSTRUCTIONS = 8000;
export const MAX_SKILLS_PER_PROMPT = 3;

/**
 * Things a skill may not tell the agent to do.
 *
 * These are the rules the pipeline keeps on behalf of people who did not ask
 * to be contacted: the outreach cap, robots.txt, honest claims about a site
 * we have actually looked at. A self-improving system that can rewrite its
 * own guardrails has no guardrails, so an edit matching any of these is
 * rejected outright — from the agent, and with a clear message from a person,
 * who can still change the real limits in settings where they belong.
 */
export const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /ignore\s+(the\s+)?(daily\s+)?(outreach\s+)?(cap|limit)/i,
    why: 'the outreach cap is set in settings, not in a skill',
  },
  {
    pattern: /(ignore|bypass|skip|disregard)\s+robots(\.txt)?/i,
    why: 'the crawler obeys robots.txt and that is not negotiable',
  },
  {
    pattern: /send\s+(the\s+)?(email|outreach)\s+(without|regardless)/i,
    why: 'whether unattended sending is allowed is a policy setting',
  },
  {
    pattern: /(invent|make up|fabricate)\s+(a\s+)?(reviews?|testimonials?|observations?|statistics?)/i,
    why: 'outreach may only cite what was actually observed',
  },
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    why: 'that is prompt injection, whoever wrote it',
  },
];

export interface SkillInput {
  name: string;
  description: string;
  whenToUse: string;
  instructions: string;
  stages?: string[];
  tags?: string[];
  slug?: string;
  rationale?: string;
}

export interface SkillValidation {
  ok: boolean;
  problems: string[];
}

export function validateSkill(input: SkillInput): SkillValidation {
  const problems: string[] = [];

  if (input.name.trim().length < 3) problems.push('A skill needs a name.');
  if (input.instructions.trim().length < 20) {
    problems.push('The instructions are too short to be worth loading.');
  }
  if (input.instructions.length > MAX_INSTRUCTIONS) {
    problems.push(`The instructions are longer than ${MAX_INSTRUCTIONS} characters.`);
  }
  if (input.whenToUse.trim().length < 5) {
    problems.push('Say when this applies — that line is what selection matches on.');
  }

  const body = `${input.name}\n${input.description}\n${input.whenToUse}\n${input.instructions}`;
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(body)) problems.push(`Rejected: ${rule.why}.`);
  }

  return { ok: problems.length === 0, problems };
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  );
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export async function listSkills(
  db: Db,
  userId: string,
  status?: 'active' | 'proposed' | 'archived',
): Promise<AgentSkill[]> {
  return db
    .select()
    .from(agentSkills)
    .where(
      status
        ? and(eq(agentSkills.userId, userId), eq(agentSkills.status, status))
        : eq(agentSkills.userId, userId),
    )
    .orderBy(desc(agentSkills.updatedAt))
    .limit(200);
}

export async function getSkill(db: Db, userId: string, id: string): Promise<AgentSkill | null> {
  const rows = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSkillBySlug(db: Db, userId: string, slug: string): Promise<AgentSkill | null> {
  const rows = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.slug, slug), eq(agentSkills.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function skillRevisions(db: Db, skillId: string) {
  return db
    .select()
    .from(agentSkillRevisions)
    .where(eq(agentSkillRevisions.skillId, skillId))
    .orderBy(desc(agentSkillRevisions.version))
    .limit(50);
}

/* ------------------------------------------------------------------ */
/* Selection                                                          */
/* ------------------------------------------------------------------ */

export interface ScoredSkill {
  skill: AgentSkill;
  score: number;
}

/**
 * How well does this skill fit the job in hand?
 *
 * Weighted towards `whenToUse`, because that is the line written to answer
 * exactly this question. A skill scoped to this stage gets a real bonus but
 * not a free pass — a stage-scoped skill about photography should still lose
 * to an unscoped one about the trade being written about.
 */
export function scoreSkill(skill: AgentSkill, task: string, stage?: string): number {
  const tokens = tokenise(task);
  const stages = parseList(skill.stages);
  const tags = parseList(skill.tags);

  if (stage && stages.length && !stages.includes(stage)) return 0;

  const whenScore = keywordOverlap(tokens, tokenise(skill.whenToUse));
  const aboutScore = keywordOverlap(tokens, tokenise(`${skill.name} ${skill.description}`));
  const tagScore = keywordOverlap(tokens, tokenise(tags.join(' ')));

  const relevance = whenScore * 0.55 + aboutScore * 0.25 + tagScore * 0.2;
  const stageBonus = stage && stages.includes(stage) ? 0.25 : 0;

  // A skill that has been used and survived is worth a nudge — but a small
  // one, or a skill that fired once early would crowd out better ones for
  // ever.
  const trackRecord = Math.min(skill.successCount, 10) * 0.01;

  return relevance + stageBonus + trackRecord;
}

export interface SelectOptions {
  stage?: CampaignStage | string;
  /** What is being worked on, in words. */
  task: string;
  limit?: number;
}

/**
 * Pick the skills to load.
 *
 * A stage-scoped skill with no keyword match still gets in when nothing else
 * does: it was scoped to this stage on purpose, and "nothing matched, so
 * nothing was loaded" is the failure mode that makes people stop writing
 * skills.
 */
export async function selectSkills(
  db: Db,
  userId: string,
  options: SelectOptions,
): Promise<AgentSkill[]> {
  const limit = Math.min(options.limit ?? MAX_SKILLS_PER_PROMPT, 8);
  const active = await listSkills(db, userId, 'active');
  if (active.length === 0) return [];

  const scored: ScoredSkill[] = active
    .map((skill) => ({ skill, score: scoreSkill(skill, options.task, options.stage) }))
    .filter((entry) => entry.score > 0.05)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 && options.stage) {
    return active
      .filter((skill) => parseList(skill.stages).includes(String(options.stage)))
      .slice(0, limit);
  }

  return scored.slice(0, limit).map((entry) => entry.skill);
}

/** The menu: one line each, for a model deciding what it needs. */
export function renderSkillMenu(skills: AgentSkill[]): string {
  if (skills.length === 0) return '';
  return skills
    .map((skill) => `- ${skill.slug}: ${skill.description || skill.name}. Use when ${skill.whenToUse}`)
    .join('\n');
}

/** The bodies, for the skills that were selected. */
export function renderSkills(skills: AgentSkill[]): string {
  if (skills.length === 0) return '';

  return skills
    .map(
      (skill) =>
        `### ${skill.name}\n${skill.whenToUse ? `Applies when ${skill.whenToUse}\n` : ''}\n${skill.instructions.trim()}`,
    )
    .join('\n\n');
}

/** Record that these skills were loaded. */
export async function noteSkillUse(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(agentSkills)
      .set({ useCount: sql`${agentSkills.useCount} + 1`, lastUsedAt: new Date().toISOString() })
      .where(inArray(agentSkills.id, ids));
  } catch {
    // Bookkeeping only.
  }
}

/** Record that a run which loaded these skills got to the end. */
export async function noteSkillSuccess(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(agentSkills)
      .set({ successCount: sql`${agentSkills.successCount} + 1` })
      .where(inArray(agentSkills.id, ids));
  } catch {
    // Bookkeeping only.
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export interface SaveSkillOptions extends SkillInput {
  userId: string;
  author: 'user' | 'agent';
  /** `proposed` keeps it out of every prompt until somebody approves it. */
  status?: 'active' | 'proposed' | 'archived';
  note?: string;
}

export interface SaveResult {
  ok: boolean;
  skill?: AgentSkill;
  created?: boolean;
  problems?: string[];
}

/**
 * Create a skill, or save a new version of one.
 *
 * Matching is by slug, so an agent that sets out to "write a skill about
 * opening lines" twice ends up editing its own rather than accumulating
 * near-duplicates. A locked skill is never modified, whoever asks.
 */
export async function saveSkill(db: Db, options: SaveSkillOptions): Promise<SaveResult> {
  const validation = validateSkill(options);
  if (!validation.ok) return { ok: false, problems: validation.problems };

  const slug = slugify(options.slug || options.name);
  const now = new Date().toISOString();
  const existing = await getSkillBySlug(db, options.userId, slug);

  if (existing) {
    if (existing.locked && options.author === 'agent') {
      return { ok: false, problems: ['That skill is locked. Only you can change it.'] };
    }

    // The version that is being replaced is what gets archived — the history
    // then reads as a sequence of things that were once true, rather than a
    // list of edits with the current state missing from the top.
    await db.insert(agentSkillRevisions).values({
      id: newId(),
      skillId: existing.id,
      userId: options.userId,
      version: existing.version,
      name: existing.name,
      description: existing.description,
      whenToUse: existing.whenToUse,
      instructions: existing.instructions,
      author: existing.origin,
      note: options.note?.slice(0, 400) ?? '',
      createdAt: now,
    });

    const status = options.status ?? (options.author === 'agent' ? existing.status : 'active');

    await db
      .update(agentSkills)
      .set({
        name: options.name.slice(0, 120),
        description: options.description.slice(0, 300),
        whenToUse: options.whenToUse.slice(0, 300),
        instructions: options.instructions.slice(0, MAX_INSTRUCTIONS),
        stages: JSON.stringify(options.stages ?? parseList(existing.stages)),
        tags: JSON.stringify(options.tags ?? parseList(existing.tags)),
        rationale: options.rationale?.slice(0, 600) ?? existing.rationale,
        version: existing.version + 1,
        status,
        updatedAt: now,
      })
      .where(eq(agentSkills.id, existing.id));

    const updated = await getSkill(db, options.userId, existing.id);
    return { ok: true, skill: updated ?? existing, created: false };
  }

  const row = {
    id: newId(),
    userId: options.userId,
    slug,
    name: options.name.slice(0, 120),
    description: options.description.slice(0, 300),
    whenToUse: options.whenToUse.slice(0, 300),
    instructions: options.instructions.slice(0, MAX_INSTRUCTIONS),
    stages: JSON.stringify(options.stages ?? []),
    tags: JSON.stringify(options.tags ?? []),
    origin: options.author,
    status: options.status ?? (options.author === 'agent' ? 'proposed' : 'active'),
    version: 1,
    locked: false,
    useCount: 0,
    lastUsedAt: null,
    successCount: 0,
    rationale: options.rationale?.slice(0, 600) ?? '',
    createdAt: now,
    updatedAt: now,
  } satisfies typeof agentSkills.$inferInsert;

  await db.insert(agentSkills).values(row);
  return { ok: true, skill: row as AgentSkill, created: true };
}

export async function setSkillStatus(
  db: Db,
  userId: string,
  id: string,
  status: 'active' | 'proposed' | 'archived',
): Promise<void> {
  await db
    .update(agentSkills)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, userId)));
}

export async function setSkillLock(
  db: Db,
  userId: string,
  id: string,
  locked: boolean,
): Promise<void> {
  await db
    .update(agentSkills)
    .set({ locked, updatedAt: new Date().toISOString() })
    .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, userId)));
}

export async function deleteSkill(db: Db, userId: string, id: string): Promise<void> {
  await db.delete(agentSkills).where(and(eq(agentSkills.id, id), eq(agentSkills.userId, userId)));
}

/** Put a skill back to an earlier version, keeping the history intact. */
export async function revertSkill(
  db: Db,
  userId: string,
  skillId: string,
  version: number,
): Promise<SaveResult> {
  const skill = await getSkill(db, userId, skillId);
  if (!skill) return { ok: false, problems: ['No such skill.'] };

  const rows = await db
    .select()
    .from(agentSkillRevisions)
    .where(and(eq(agentSkillRevisions.skillId, skillId), eq(agentSkillRevisions.version, version)))
    .limit(1);

  const revision = rows[0];
  if (!revision) return { ok: false, problems: ['No such version.'] };

  return saveSkill(db, {
    userId,
    slug: skill.slug,
    name: revision.name,
    description: revision.description,
    whenToUse: revision.whenToUse,
    instructions: revision.instructions,
    stages: parseList(skill.stages),
    tags: parseList(skill.tags),
    author: 'user',
    status: 'active',
    note: `Reverted to version ${version}.`,
    rationale: `Reverted to version ${version}.`,
  });
}

export function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
