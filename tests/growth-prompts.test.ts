/**
 * The editable half of the prompts.
 *
 * The instructions are the product and are meant to be changed. The contract
 * — the JSON shape everything downstream parses — is not, and the whole point
 * of splitting them is that no edit to the first can break the second.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_LENGTH,
  PROMPT_SPECS,
  defaultInstructions,
  promptSpec,
  stripContract,
  withContract,
} from '~/lib/growth/prompts';

describe('the registry', () => {
  it('covers every model call the pipeline makes', () => {
    expect(PROMPT_SPECS.map((spec) => spec.key).sort()).toEqual([
      'outreach',
      'plan',
      'qualify',
      'shortlist',
    ]);
  });

  it('gives every prompt instructions, a contract and something to read', () => {
    for (const spec of PROMPT_SPECS) {
      expect(spec.instructions.trim().length).toBeGreaterThan(100);
      expect(spec.contract).toContain('JSON');
      expect(spec.label).toBeTruthy();
      expect(spec.description).toBeTruthy();
      expect(spec.stage).toBeTruthy();
    }
  });

  it('keeps every default inside what the edit box will accept', () => {
    for (const spec of PROMPT_SPECS) {
      expect(spec.instructions.length).toBeLessThan(MAX_PROMPT_LENGTH);
    }
  });

  it('does not carry the contract in the instructions, which would send it twice', () => {
    for (const spec of PROMPT_SPECS) {
      expect(spec.instructions).not.toContain('Return ONLY JSON');
    }
  });

  it('throws on a key that is not a prompt', () => {
    expect(() => promptSpec('nonsense' as never)).toThrow();
  });
});

describe('withContract', () => {
  it('runs on the default when there is no override', () => {
    const system = withContract('plan');
    expect(system).toContain(defaultInstructions('plan'));
    expect(system).toContain(promptSpec('plan').contract);
  });

  it('runs on the default when the override is blank or only spaces', () => {
    expect(withContract('plan', '')).toBe(withContract('plan'));
    expect(withContract('plan', '   \n  ')).toBe(withContract('plan'));
    expect(withContract('plan', null)).toBe(withContract('plan'));
  });

  it('uses the override instead of the default', () => {
    const system = withContract('qualify', 'Only score bakeries.');
    expect(system).toContain('Only score bakeries.');
    expect(system).not.toContain('FREELANCE brand and web designer');
  });

  /**
   * The one thing an edit must not be able to do. Someone rewriting the
   * planner's tone should not be able to stop plans parsing, and the shape is
   * appended whatever they wrote.
   */
  it('appends the contract to any override, last', () => {
    for (const spec of PROMPT_SPECS) {
      const system = withContract(spec.key, 'Do whatever you like.');
      expect(system.endsWith(spec.contract)).toBe(true);
    }
  });

  it('does not send the contract twice when the override already carries it', () => {
    const spec = promptSpec('shortlist');
    const pasted = `Pick the good ones.\n\n${spec.contract}`;
    const system = withContract('shortlist', pasted);

    expect(system.split('Return ONLY JSON')).toHaveLength(2);
    expect(system).toContain('Pick the good ones.');
  });

  it('cuts a hand-edited copy of the contract at the right place', () => {
    const system = withContract(
      'qualify',
      'Score bakeries only.\n\nReturn ONLY JSON: {"fit_score": 0, "something_else": true}',
    );

    expect(system).toContain('Score bakeries only.');
    expect(system).not.toContain('something_else');
    expect(system.endsWith(promptSpec('qualify').contract)).toBe(true);
  });
});

describe('stripContract', () => {
  it('leaves instructions with no contract in them alone', () => {
    expect(stripContract('Just instructions.', 'Return ONLY JSON: {}')).toBe('Just instructions.');
  });

  it('leaves a mention that is not the trailing contract alone', () => {
    // The marker is found from the END, so prose before the real contract
    // survives — only the last one is cut.
    const text = 'Write it well.\n\nReturn ONLY JSON: {"a":1}';
    expect(stripContract(text, 'Return ONLY JSON: {"a":1}')).toBe('Write it well.');
  });
});
