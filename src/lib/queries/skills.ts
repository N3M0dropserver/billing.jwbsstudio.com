/**
 * Reading and writing the agent's skills.
 *
 * A run loads them once and passes them down, like the prompt overrides —
 * a tick plans several prospects and they all want the same rows.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { agentSkills, type AgentSkillRow } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import {
  ANY_MATCH,
  BUILT_IN_SKILLS,
  MAX_SKILL_LENGTH,
  isSkillStage,
  mergeSkills,
  skillSlug,
  type AgentSkill,
  type SkillMatch,
  type SkillStage,
} from '~/lib/growth/skills';

const OBJECTIVES = ['conversion', 'awareness', 'credibility'] as const;

/** Read the match rules back out of the column, coercing field by field. */
export function parseMatch(json: string): SkillMatch {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    return { ...ANY_MATCH };
  }

  const website = raw.website;

  return {
    niches: Array.isArray(raw.niches)
      ? raw.niches.map((value) => String(value).trim().toLowerCase()).filter(Boolean).slice(0, 30)
      : [],
    objectives: Array.isArray(raw.objectives)
      ? (raw.objectives
          .map((value) => String(value))
          .filter((value): value is (typeof OBJECTIVES)[number] =>
            OBJECTIVES.includes(value as (typeof OBJECTIVES)[number]),
          )
          .slice(0, 3))
      : [],
    website: website === 'with' || website === 'without' ? website : 'any',
  };
}

function fromRow(row: AgentSkillRow): AgentSkill | null {
  if (!isSkillStage(row.stage)) return null;

  return {
    slug: row.slug,
    name: row.name,
    stage: row.stage,
    summary: row.summary,
    instructions: row.instructions,
    match: parseMatch(row.matchRules),
    enabled: row.enabled,
    builtIn: row.overridesBuiltIn,
  };
}

/**
 * Every skill in force for this user: the built-ins, with their edits applied,
 * plus anything they wrote themselves.
 *
 * Nothing here throws. A skills table that cannot be read is a run on the
 * built-ins, not a failed run.
 */
export async function loadSkills(db: Db, userId: string): Promise<AgentSkill[]> {
  try {
    const rows = await db.select().from(agentSkills).where(eq(agentSkills.userId, userId));
    return mergeSkills(rows.map(fromRow).filter((skill): skill is AgentSkill => skill !== null));
  } catch {
    return [...BUILT_IN_SKILLS];
  }
}

/** One skill by slug, built-in or not, for the edit page. */
export async function loadSkill(db: Db, userId: string, slug: string): Promise<AgentSkill | null> {
  const all = await loadSkills(db, userId);
  return all.find((skill) => skill.slug === slug) ?? null;
}

export interface SkillInput {
  slug?: string;
  name: string;
  stage: SkillStage;
  summary: string;
  instructions: string;
  match: SkillMatch;
  enabled: boolean;
}

/**
 * Save a skill.
 *
 * An edit of a built-in keeps its slug, so it stays the same skill and a
 * later reset puts the shipped version back. A new one gets a slug from its
 * name, made unique against everything already in force — including the
 * built-ins, because colliding with one would silently replace it.
 */
export async function saveSkill(db: Db, userId: string, input: SkillInput): Promise<string> {
  const existing = await db.select().from(agentSkills).where(eq(agentSkills.userId, userId));
  const taken = new Set(existing.map((row) => row.slug));
  const builtInSlugs = new Set(BUILT_IN_SKILLS.map((skill) => skill.slug));

  const slug = input.slug || uniqueSlug(skillSlug(input.name), taken, builtInSlugs);
  const now = new Date().toISOString();

  const values = {
    name: input.name.slice(0, 160) || 'Untitled skill',
    stage: input.stage,
    summary: input.summary.slice(0, 300),
    instructions: input.instructions.slice(0, MAX_SKILL_LENGTH),
    matchRules: JSON.stringify(input.match),
    enabled: input.enabled,
    overridesBuiltIn: builtInSlugs.has(slug),
    updatedAt: now,
  };

  const row = existing.find((candidate) => candidate.slug === slug);

  if (row) {
    await db.update(agentSkills).set(values).where(eq(agentSkills.id, row.id));
    return slug;
  }

  await db.insert(agentSkills).values({ id: newId(), userId, slug, ...values, createdAt: now });
  return slug;
}

/**
 * Delete a skill row.
 *
 * For one of the user's own that is the end of it. For an edited built-in it
 * is a reset: the row goes and the shipped version is in force again.
 */
export async function deleteSkill(db: Db, userId: string, slug: string): Promise<void> {
  await db
    .delete(agentSkills)
    .where(and(eq(agentSkills.userId, userId), eq(agentSkills.slug, slug)));
}

/**
 * Turn one on or off without opening it.
 *
 * Disabling a built-in has to write a row — there is nowhere else to record
 * it — so this is a save of the shipped version with `enabled` flipped.
 */
export async function setSkillEnabled(
  db: Db,
  userId: string,
  slug: string,
  enabled: boolean,
): Promise<void> {
  const skill = await loadSkill(db, userId, slug);
  if (!skill) return;

  await saveSkill(db, userId, {
    slug,
    name: skill.name,
    stage: skill.stage,
    summary: skill.summary,
    instructions: skill.instructions,
    match: skill.match,
    enabled,
  });
}

function uniqueSlug(base: string, taken: Set<string>, builtIn: Set<string>): string {
  if (!taken.has(base) && !builtIn.has(base)) return base;

  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate) && !builtIn.has(candidate)) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

/** Read a match out of a submitted form. */
export function matchFromForm(form: FormData): SkillMatch {
  const website = String(form.get('website') ?? 'any');

  return {
    niches: String(form.get('niches') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 30),
    objectives: OBJECTIVES.filter((objective) => form.get(`objective-${objective}`) === 'yes'),
    website: website === 'with' || website === 'without' ? website : 'any',
  };
}
