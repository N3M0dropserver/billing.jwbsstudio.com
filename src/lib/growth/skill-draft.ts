/**
 * Drafting a skill from a sentence.
 *
 * Writing good instructions for a model is a skill of its own, and "describe
 * what you want and get a first draft you edit" is a much lower bar to clear
 * than a blank textarea. The draft is always shown for editing before it is
 * saved — nothing here writes to the database.
 *
 * What comes back is coerced field by field and every field is clamped. The
 * output of this call becomes text inside a later system prompt, so it is
 * treated exactly like anything else a model wrote.
 */

import { MODELS, type AiResult } from '../ai/index';
import { trackedGenerateJson, type AiUsageContext } from '../ai/usage';
import {
  MAX_SKILL_LENGTH,
  SKILL_STAGES,
  isSkillStage,
  type SkillMatch,
  type SkillStage,
} from './skills';

export interface SkillDraft {
  name: string;
  stage: SkillStage;
  summary: string;
  instructions: string;
  match: SkillMatch;
}

const SYSTEM = `You write a SKILL for an automated pipeline that builds unsolicited concept websites for small businesses in New Zealand and Australia, and emails them to the owner.

A skill is case-specific know-how appended to one stage's system prompt, for the prospects it applies to. It is NOT a general description of good design. The general instructions already exist; a skill earns its place by saying something that is true for THIS kind of business and not for the others.

The stages a skill can land in:
  qualify  - deciding whether a business is worth approaching at all
  plan     - writing the page: its sections, structure, and every word of copy
  imagery  - describing the photographs the page needs, and generating what is missing
  outreach - writing the cold email that carries the link

Write "instructions" as direct, concrete guidance to the model doing that stage. Rules:
- Say what to DO, in specifics. "Put the address and the hours above the fold" is a rule. "Consider the user's needs" is not.
- Name the things a page for this trade must contain, and the things it must not claim.
- Where a failure mode is common, name it and say what to write instead.
- 120-350 words. Short lines. No preamble, no headings, no markdown emphasis.
- Never instruct the model to invent facts, and never override the standing rule that every claim must come from the business's own material.

"niches" are lowercase substrings matched against the trade and the directory category — "cafe", "plumb", "hair". Use the stem so plurals and compounds match. Leave EMPTY when the skill applies to every trade.

"objectives" limits it to pages with a particular job: conversion, awareness, credibility. Leave EMPTY for all three.

"website" is "any", "with" (only businesses that already have a site) or "without" (only those that do not).

Be narrow. A skill that applies to everything is a change to the system prompt, not a skill.`;

const CONTRACT = `Return ONLY JSON:
{"name":"short name","stage":"plan","summary":"one line for a list","instructions":"the know-how","niches":["cafe"],"objectives":[],"website":"any"}`;

const OBJECTIVES = ['conversion', 'awareness', 'credibility'] as const;

export async function draftSkill(
  ai: Ai,
  description: string,
  usage: AiUsageContext,
  /** The stage the user already picked, where they picked one. */
  preferredStage?: SkillStage,
): Promise<AiResult<SkillDraft>> {
  const prompt = [
    'Write a skill for this:',
    description.slice(0, 2000),
    '',
    preferredStage
      ? `It must be for the ${preferredStage} stage.`
      : `Choose the stage it belongs in: ${SKILL_STAGES.map((entry) => entry.stage).join(', ')}.`,
  ].join('\n');

  const result = await trackedGenerateJson<Record<string, unknown>>(
    ai,
    {
      system: `${SYSTEM}\n\n${CONTRACT}`,
      prompt,
      model: MODELS.text,
      maxTokens: 1200,
      temperature: 0.6,
    },
    usage,
  );

  if (!result.ok) return result;

  const draft = normaliseDraft(result.data, preferredStage);
  if (!draft.instructions) {
    return { ok: false, error: 'The model returned a skill with nothing in it.' };
  }

  return { ok: true, data: draft };
}

/** Coerce the draft field by field. Every one of these reaches a prompt later. */
export function normaliseDraft(
  raw: Record<string, unknown>,
  preferredStage?: SkillStage,
): SkillDraft {
  const str = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
  const stage = str(raw.stage, 20);
  const website = str(raw.website, 10);

  return {
    name: str(raw.name, 160) || 'Untitled skill',
    stage: preferredStage ?? (isSkillStage(stage) ? stage : 'plan'),
    summary: str(raw.summary, 300),
    instructions: str(raw.instructions, MAX_SKILL_LENGTH),
    match: {
      niches: Array.isArray(raw.niches)
        ? raw.niches
            .map((value) => str(value, 40).toLowerCase())
            .filter(Boolean)
            .slice(0, 30)
        : [],
      objectives: Array.isArray(raw.objectives)
        ? OBJECTIVES.filter((objective) =>
            (raw.objectives as unknown[]).some((value) => String(value) === objective),
          )
        : [],
      website: website === 'with' || website === 'without' ? website : 'any',
    },
  };
}
