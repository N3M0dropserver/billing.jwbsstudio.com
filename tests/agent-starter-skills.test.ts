/**
 * The starter set.
 *
 * Eight skills written for a second, parallel skills system before anyone
 * noticed this one existed. The mechanism was thrown away and the writing
 * kept, so the thing worth testing is that the writing actually satisfies the
 * system it was moved onto — including the safety rules it was never written
 * against.
 */

import { describe, expect, it } from 'vitest';
import { STARTER_SKILLS } from '~/lib/agent/starter-skills';
import { validateSkill, slugify, scoreSkill } from '~/lib/agent/skills';
import { CAMPAIGN_STAGES } from '~/lib/db/schema';

describe('every starter skill', () => {
  it('passes the validator, including the rules it was not written against', () => {
    for (const skill of STARTER_SKILLS) {
      const result = validateSkill(skill);
      expect(result.problems, `${skill.slug}: ${result.problems.join('; ')}`).toEqual([]);
    }
  });

  it('carries a slug that survives slugify unchanged', () => {
    for (const skill of STARTER_SKILLS) {
      expect(slugify(skill.slug!)).toBe(skill.slug);
    }
  });

  it('has a unique slug', () => {
    const slugs = STARTER_SKILLS.map((skill) => skill.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('names only stages the pipeline actually has', () => {
    for (const skill of STARTER_SKILLS) {
      for (const stage of skill.stages ?? []) {
        expect(CAMPAIGN_STAGES as readonly string[]).toContain(stage);
      }
    }
  });

  it('says when it applies, since that line is what selection matches on', () => {
    for (const skill of STARTER_SKILLS) {
      expect(skill.whenToUse.length).toBeGreaterThan(30);
      expect(skill.description.length).toBeGreaterThan(20);
    }
  });
});

describe('the set as a whole', () => {
  it('covers the four stages that read a skill', () => {
    const stages = new Set(STARTER_SKILLS.flatMap((skill) => skill.stages ?? []));
    expect(stages).toEqual(new Set(['shortlist', 'plan', 'build', 'propose']));
  });

  /**
   * Selection is by keyword overlap against `whenToUse`, so the test that
   * matters is not "does it parse" but "does a cafe actually get the cafe
   * one". A set that never surfaces is a set that does nothing.
   */
  it('scores the hospitality skill above the others for a cafe', () => {
    const rows = STARTER_SKILLS.map((skill, i) => ({
      id: String(i),
      slug: skill.slug!,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      instructions: skill.instructions,
      stages: JSON.stringify(skill.stages ?? []),
      tags: JSON.stringify(skill.tags ?? []),
      successCount: 0,
    }));

    const task = 'Design a one-page site for a cafe and bakery in Darlinghurst';
    const ranked = rows
      .map((row) => ({ slug: row.slug, score: scoreSkill(row as never, task, 'plan') }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0]?.slug).toBe('hospitality-page');
    // A skill for another stage scores zero rather than merely lower.
    expect(ranked.find((r) => r.slug === 'first-line-that-lands')?.score).toBe(0);
  });

  it('scores the trades skill above hospitality for a plumber', () => {
    const rows = STARTER_SKILLS.map((skill) => ({
      slug: skill.slug!,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      instructions: skill.instructions,
      stages: JSON.stringify(skill.stages ?? []),
      tags: JSON.stringify(skill.tags ?? []),
      successCount: 0,
    }));

    const task = 'Design a one-page site for a plumber in Wellington who quotes for callouts';
    const by = (slug: string) =>
      scoreSkill(rows.find((r) => r.slug === slug) as never, task, 'plan');

    expect(by('trades-page')).toBeGreaterThan(by('hospitality-page'));
  });
});
