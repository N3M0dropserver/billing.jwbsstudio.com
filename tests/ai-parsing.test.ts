/**
 * Reading what a model actually returned.
 *
 * Both halves of this file come from one growth run, where every prospect
 * scored fit 0 and four of ten plans fell through to a scaffold. Neither was
 * the model being bad at the job: one was a response shape we did not handle,
 * and the other was JSON that said exactly the right thing in a form
 * `JSON.parse` refuses.
 */

import { describe, expect, it } from 'vitest';
import {
  describeShape,
  extractJson,
  parseLooseJson,
  repairJson,
  repairTruncated,
  responseText,
} from '../src/lib/ai/index';

describe('responseText', () => {
  it('reads the documented shape', () => {
    expect(responseText({ response: 'hello' })).toBe('hello');
  });

  it('reads a bare string', () => {
    expect(responseText('hello')).toBe('hello');
  });

  /**
   * The run that prompted this logged `TypeError: text.trim is not a
   * function` on every qualify call, which the engine recorded as a failed
   * call and scored as fit 0 — so the shortlist ranked on need alone and
   * picked the ten businesses with no website at all.
   */
  it('reads content parts, rather than throwing on them', () => {
    expect(responseText({ response: [{ type: 'text', text: 'hello' }] })).toBe('hello');
    expect(responseText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('reads an OpenAI-compatible body', () => {
    expect(responseText({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
    expect(responseText({ choices: [{ text: 'hello' }] })).toBe('hello');
  });

  it('reads a REST envelope that was not unwrapped', () => {
    expect(responseText({ result: { response: 'hello' } })).toBe('hello');
  });

  it('returns null when there is no text, rather than an empty string', () => {
    expect(responseText({ errors: [{ code: 7000 }] })).toBeNull();
    expect(responseText(null)).toBeNull();
    expect(responseText(42)).toBeNull();
  });

  it('describes an unreadable shape by its keys, never its values', () => {
    const description = describeShape({ errors: [{ message: 'a customer address' }] });
    expect(description).toContain('errors');
    expect(description).not.toContain('customer');
  });
});

describe('parseLooseJson', () => {
  it('parses ordinary JSON', () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses out of a code fence', () => {
    expect(parseLooseJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({ a: 1 });
  });

  /**
   * The plan prompt asks for paragraphs separated by a blank line, so the
   * model writes one — inside a JSON string, where it is a control character
   * and `JSON.parse` rejects it. This was the single largest cause of
   * "The model returned malformed JSON" in a run.
   */
  it('parses body copy with real newlines in it', () => {
    const parsed = parseLooseJson<{ body: string }>('{"body":"First para.\n\nSecond para."}');
    expect(parsed?.body).toBe('First para.\n\nSecond para.');
  });

  it('parses a tab inside a string', () => {
    expect(parseLooseJson<{ a: string }>('{"a":"x\ty"}')?.a).toBe('x\ty');
  });

  it('parses through a trailing comma', () => {
    expect(parseLooseJson('{"a":1,}')).toEqual({ a: 1 });
    expect(parseLooseJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('leaves a comma inside a string alone', () => {
    expect(parseLooseJson<{ a: string }>('{"a":"one, two"}')?.a).toBe('one, two');
  });

  it('does not mistake a brace inside a string for structure', () => {
    expect(parseLooseJson<{ a: string }>('{"a":"a { brace"}')?.a).toBe('a { brace');
  });

  it('keeps an escaped quote escaped', () => {
    expect(parseLooseJson<{ a: string }>('{"a":"say \\"hi\\""}')?.a).toBe('say "hi"');
  });

  it('returns null when there is no JSON at all', () => {
    expect(parseLooseJson('I am afraid I cannot help with that.')).toBeNull();
  });
});

describe('parseLooseJson on a response that ran out of tokens', () => {
  it('closes a value cut off mid-string', () => {
    const parsed = parseLooseJson<{ summary: string }>('{"summary":"A one-page site for');
    expect(parsed?.summary).toBe('A one-page site for');
  });

  /**
   * The shape that matters: a plan stopped partway through its last section.
   * Everything before it is a usable page, and a page missing the tail of its
   * final section beats a three-heading scaffold by a distance. The repair
   * drops back to the last complete field rather than the last complete
   * section, so a half-written section keeps the fields that did arrive.
   */
  it('keeps the sections that did arrive when the last one is incomplete', () => {
    const truncated =
      '{"summary":"x","sections":[' +
      '{"id":"hero","heading":"Roasted in Marrickville"},' +
      '{"id":"about","hea';

    const parsed = parseLooseJson<{
      summary: string;
      sections: Array<{ id: string; heading?: string }>;
    }>(truncated);

    expect(parsed?.summary).toBe('x');
    expect(parsed?.sections.map((section) => section.id)).toEqual(['hero', 'about']);
    expect(parsed?.sections[0]?.heading).toBe('Roasted in Marrickville');
    // The key that was cut off mid-name is gone, not guessed at.
    expect(Object.keys(parsed?.sections[1] ?? {})).toEqual(['id']);
  });

  it('closes a key left without a value', () => {
    expect(parseLooseJson('{"a":1,"b":')).toEqual({ a: 1, b: null });
  });

  it('closes nested containers in the right order', () => {
    const parsed = parseLooseJson<{ a: { b: number[] } }>('{"a":{"b":[1,2');
    expect(parsed).toEqual({ a: { b: [1, 2] } });
  });

  it('does not invent an object out of nothing', () => {
    expect(parseLooseJson('no json here, just prose')).toBeNull();
  });
});

describe('repairJson', () => {
  it('leaves valid JSON byte-identical', () => {
    const valid = '{"a":[1,2,{"b":"c"}],"d":null}';
    expect(repairJson(valid)).toBe(valid);
  });

  it('escapes control characters only inside strings', () => {
    expect(repairJson('{\n"a":"x\ny"\n}')).toBe('{\n"a":"x\\ny"\n}');
  });
});

describe('repairTruncated', () => {
  it('offers the longest candidate first', () => {
    const candidates = repairTruncated('{"a":[1,2,3');
    expect(candidates[0]).toBe('{"a":[1,2,3]}');
    expect(candidates.length).toBeGreaterThan(1);
  });

  it('is bounded, so a huge truncated array cannot spin', () => {
    const huge = '[' + '1,'.repeat(5000);
    expect(repairTruncated(huge).length).toBeLessThanOrEqual(40);
  });
});

describe('extractJson', () => {
  it('still returns null for an unbalanced value, as its callers expect', () => {
    expect(extractJson('{"a":')).toBeNull();
  });
});
