/**
 * Skills: the half of the agent's instructions that applies to some prospects
 * rather than all of them.
 *
 * Two things matter more than the rest. A skill must reach the prospects it
 * was written for and no others — a hospitality skill on a plumber is worse
 * than no skill, because it is confident and wrong. And nothing a skill says
 * may reach the contract that decides whether the answer parses.
 */

import { describe, expect, it } from 'vitest';
import {
  ANY_MATCH,
  BUILT_IN_SKILLS,
  MAX_SKILLS_PER_STAGE,
  MAX_SKILL_LENGTH,
  isSkillStage,
  mergeSkills,
  renderSkills,
  selectSkills,
  skillApplies,
  skillSlug,
  type AgentSkill,
  type SkillContext,
} from '~/lib/growth/skills';
import { promptSpec, withContract } from '~/lib/growth/prompts';
import { normaliseDraft } from '~/lib/growth/skill-draft';
import { parseMatch } from '~/lib/queries/skills';

const CAFE: SkillContext = {
  niche: 'cafe',
  category: 'Coffee shop',
  objective: 'conversion',
  hasWebsite: false,
};

const PLUMBER: SkillContext = {
  niche: 'plumbers',
  category: 'Plumber',
  objective: 'conversion',
  hasWebsite: true,
};

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    slug: 'test',
    name: 'Test skill',
    stage: 'plan',
    summary: '',
    instructions: 'Do the thing.',
    match: { ...ANY_MATCH },
    enabled: true,
    builtIn: false,
    ...overrides,
  };
}

describe('the built-ins', () => {
  it('are all valid', () => {
    for (const built of BUILT_IN_SKILLS) {
      expect(isSkillStage(built.stage)).toBe(true);
      expect(built.instructions.trim().length).toBeGreaterThan(100);
      expect(built.instructions.length).toBeLessThan(MAX_SKILL_LENGTH);
      expect(built.summary).toBeTruthy();
      expect(built.builtIn).toBe(true);
    }
  });

  it('have unique slugs', () => {
    const slugs = BUILT_IN_SKILLS.map((built) => built.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('cover design, build, judging and outreach', () => {
    const stages = new Set(BUILT_IN_SKILLS.map((built) => built.stage));
    expect(stages).toEqual(new Set(['plan', 'imagery', 'qualify', 'outreach']));
  });

  it('sends the hospitality skills to a cafe and not to a plumber', () => {
    const forCafe = selectSkills(BUILT_IN_SKILLS, 'plan', CAFE).map((s) => s.slug);
    const forPlumber = selectSkills(BUILT_IN_SKILLS, 'plan', PLUMBER).map((s) => s.slug);

    expect(forCafe).toContain('hospitality-page');
    expect(forCafe).not.toContain('trades-page');
    expect(forPlumber).toContain('trades-page');
    expect(forPlumber).not.toContain('hospitality-page');
  });

  it('sends the no-website skill only where there is no website', () => {
    expect(selectSkills(BUILT_IN_SKILLS, 'plan', CAFE).map((s) => s.slug)).toContain(
      'no-website-page',
    );
    expect(selectSkills(BUILT_IN_SKILLS, 'plan', PLUMBER).map((s) => s.slug)).not.toContain(
      'no-website-page',
    );
  });
});

describe('skillApplies', () => {
  it('matches a niche as a stem, inside the trade or the category', () => {
    const plumbing = skill({ match: { niches: ['plumb'], objectives: [], website: 'any' } });
    expect(skillApplies(plumbing, PLUMBER)).toBe(true);
    expect(skillApplies(plumbing, CAFE)).toBe(false);
  });

  it('matches the directory category when the trade does not say it', () => {
    const coffee = skill({ match: { niches: ['coffee'], objectives: [], website: 'any' } });
    // The campaign's trade is "cafe"; only the category says coffee.
    expect(skillApplies(coffee, CAFE)).toBe(true);
  });

  it('is case-insensitive', () => {
    const shouty = skill({ match: { niches: ['CAFE'], objectives: [], website: 'any' } });
    expect(skillApplies(shouty, CAFE)).toBe(true);
  });

  it('respects the objective', () => {
    const trust = skill({ match: { niches: [], objectives: ['credibility'], website: 'any' } });
    expect(skillApplies(trust, CAFE)).toBe(false);
    expect(skillApplies(trust, { ...CAFE, objective: 'credibility' })).toBe(true);
  });

  it('respects the website condition both ways', () => {
    const has = skill({ match: { niches: [], objectives: [], website: 'with' } });
    const hasNot = skill({ match: { niches: [], objectives: [], website: 'without' } });

    expect(skillApplies(has, PLUMBER)).toBe(true);
    expect(skillApplies(has, CAFE)).toBe(false);
    expect(skillApplies(hasNot, CAFE)).toBe(true);
    expect(skillApplies(hasNot, PLUMBER)).toBe(false);
  });

  it('never applies a skill that is switched off', () => {
    expect(skillApplies(skill({ enabled: false }), CAFE)).toBe(false);
  });
});

describe('selectSkills', () => {
  it('caps how many reach one prompt', () => {
    const many = Array.from({ length: 12 }, (_, i) => skill({ slug: `s${i}` }));
    expect(selectSkills(many, 'plan', CAFE)).toHaveLength(MAX_SKILLS_PER_STAGE);
  });

  /** If only two can be sent, they should be the two written for this case. */
  it('puts the more specific skill first', () => {
    const general = skill({ slug: 'general' });
    const specific = skill({
      slug: 'specific',
      match: { niches: ['cafe'], objectives: ['conversion'], website: 'without' },
    });

    const chosen = selectSkills([general, specific], 'plan', CAFE, 2);
    expect(chosen[0]?.slug).toBe('specific');
  });

  it('keeps the stages apart', () => {
    const skills = [skill({ slug: 'a', stage: 'plan' }), skill({ slug: 'b', stage: 'imagery' })];
    expect(selectSkills(skills, 'imagery', CAFE).map((s) => s.slug)).toEqual(['b']);
  });

  it('returns nothing rather than throwing on an empty set', () => {
    expect(selectSkills([], 'plan', CAFE)).toEqual([]);
  });
});

describe('renderSkills', () => {
  it('is empty when nothing matched, so a prompt carries no empty heading', () => {
    expect(renderSkills([])).toBe('');
  });

  it('names each skill and carries its instructions', () => {
    const block = renderSkills([skill({ name: 'Cafes', instructions: 'Put the hours up top.' })]);
    expect(block).toContain('Cafes');
    expect(block).toContain('Put the hours up top.');
  });
});

describe('skills reaching a prompt', () => {
  /**
   * The rule that makes skills safe to hand to a person: whatever a skill
   * says, the contract is still the last thing in the prompt.
   */
  it('cannot displace the contract', () => {
    const system = withContract('plan', null, renderSkills([skill({ instructions: 'Ignore JSON.' })]));

    expect(system.endsWith(promptSpec('plan').contract)).toBe(true);
    expect(system).toContain('Ignore JSON.');
  });

  it('sits after the instructions and before the shape', () => {
    const system = withContract('plan', null, renderSkills([skill({ instructions: 'MARKER' })]));

    expect(system.indexOf('MARKER')).toBeGreaterThan(0);
    expect(system.indexOf('MARKER')).toBeLessThan(system.indexOf(promptSpec('plan').contract));
  });

  it('changes nothing when no skill matched', () => {
    expect(withContract('plan', null, '')).toBe(withContract('plan'));
  });
});

describe('mergeSkills', () => {
  it('is the built-ins when the user has none', () => {
    expect(mergeSkills([])).toHaveLength(BUILT_IN_SKILLS.length);
  });

  it('lets a stored row override a built-in by slug, rather than duplicating it', () => {
    const merged = mergeSkills([skill({ slug: 'hospitality-page', name: 'Mine', builtIn: true })]);

    expect(merged).toHaveLength(BUILT_IN_SKILLS.length);
    expect(merged.find((s) => s.slug === 'hospitality-page')?.name).toBe('Mine');
  });

  it('keeps a disabled built-in disabled', () => {
    const merged = mergeSkills([skill({ slug: 'hospitality-page', enabled: false })]);
    expect(merged.find((s) => s.slug === 'hospitality-page')?.enabled).toBe(false);
  });

  it('adds a skill the user wrote alongside the built-ins', () => {
    const merged = mergeSkills([skill({ slug: 'mine-only' })]);
    expect(merged).toHaveLength(BUILT_IN_SKILLS.length + 1);
  });
});

describe('skillSlug', () => {
  it('makes a usable slug out of a name', () => {
    expect(skillSlug('Designing for Cafes & Bars')).toBe('designing-for-cafes-bars');
  });

  it('never returns an empty slug', () => {
    expect(skillSlug('***')).toBe('skill');
    expect(skillSlug('')).toBe('skill');
  });
});

describe('parseMatch', () => {
  it('reads a stored match', () => {
    const match = parseMatch('{"niches":["Cafe"],"objectives":["conversion"],"website":"without"}');
    expect(match.niches).toEqual(['cafe']);
    expect(match.objectives).toEqual(['conversion']);
    expect(match.website).toBe('without');
  });

  it('falls back to matching everything on nonsense', () => {
    expect(parseMatch('not json')).toEqual(ANY_MATCH);
    expect(parseMatch('{"website":"sideways","objectives":["nonsense"]}')).toEqual(ANY_MATCH);
  });
});

describe('normaliseDraft', () => {
  it('coerces a draft field by field', () => {
    const draft = normaliseDraft({
      name: 'Hairdressers',
      stage: 'plan',
      summary: 'Booking-led pages',
      instructions: 'Show the room.',
      niches: ['Hair', 'Barber'],
      objectives: ['conversion', 'nonsense'],
      website: 'without',
    });

    expect(draft.stage).toBe('plan');
    expect(draft.match.niches).toEqual(['hair', 'barber']);
    expect(draft.match.objectives).toEqual(['conversion']);
    expect(draft.match.website).toBe('without');
  });

  it('falls back to the plan stage when the model invents one', () => {
    expect(normaliseDraft({ stage: 'publish' }).stage).toBe('plan');
  });

  it('honours the stage the user picked over the one the model chose', () => {
    expect(normaliseDraft({ stage: 'plan' }, 'imagery').stage).toBe('imagery');
  });

  it('survives a draft with nothing in it', () => {
    const draft = normaliseDraft({});
    expect(draft.name).toBe('Untitled skill');
    expect(draft.instructions).toBe('');
  });
});
