import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STAGES,
  FULL_AUTO,
  FULL_MANUAL,
  parsePolicy,
  policyFromForm,
  resolvePolicy,
  SAFE_DEFAULTS,
  serialisePolicy,
  nextStage,
  stageAtLeast,
} from '~/lib/growth/policy';

describe('stage policy', () => {
  it('leaves the consequential stages manual by default', () => {
    // Publishing a public page and emailing a stranger are the two things a
    // user should have to opt into on purpose.
    expect(SAFE_DEFAULTS.build).toBe('manual');
    expect(SAFE_DEFAULTS.propose).toBe('manual');
  });

  it('covers every stage in every preset', () => {
    for (const preset of [SAFE_DEFAULTS, FULL_AUTO, FULL_MANUAL]) {
      for (const stage of CAMPAIGN_STAGES) {
        expect(preset[stage]).toBeDefined();
      }
    }
  });

  it('layers campaign over user over baseline', () => {
    const resolved = resolvePolicy(
      JSON.stringify({ propose: 'auto' }),
      JSON.stringify({ propose: 'ai', build: 'auto' }),
    );

    expect(resolved.propose).toBe('auto'); // campaign wins
    expect(resolved.build).toBe('auto'); // user default, no campaign value
    expect(resolved.shortlist).toBe(SAFE_DEFAULTS.shortlist); // baseline
  });

  it('ignores stages and modes it does not recognise', () => {
    const parsed = parsePolicy(
      JSON.stringify({ propose: 'yolo', invent: 'auto', build: 'ai' }),
    );
    expect(parsed).toEqual({ build: 'ai' });
  });

  it('survives junk without throwing', () => {
    expect(parsePolicy('not json')).toEqual({});
    expect(parsePolicy('[1,2,3]')).toEqual({});
    expect(parsePolicy('null')).toEqual({});
    expect(parsePolicy(null)).toEqual({});
  });

  it('round-trips through serialisation', () => {
    expect(parsePolicy(serialisePolicy(FULL_AUTO))).toEqual(FULL_AUTO);
  });

  it('drops unknown keys when serialising', () => {
    const serialised = serialisePolicy({ build: 'auto', nonsense: 'auto' } as never);
    expect(JSON.parse(serialised)).toEqual({ build: 'auto' });
  });

  it('reads a policy out of form data', () => {
    const form = new FormData();
    form.set('policy.build', 'auto');
    form.set('policy.propose', 'manual');
    form.set('policy.nope', 'auto');
    form.set('policy.plan', 'nonsense');

    expect(policyFromForm(form)).toEqual({ build: 'auto', propose: 'manual' });
  });

  it('walks the stages in order and stops at the end', () => {
    expect(nextStage('brief')).toBe('discover');
    expect(nextStage('propose')).toBeNull();
    expect(stageAtLeast('build', 'plan')).toBe(true);
    expect(stageAtLeast('plan', 'build')).toBe(false);
  });
});
