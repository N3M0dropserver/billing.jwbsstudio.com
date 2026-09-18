import { describe, expect, it, vi } from 'vitest';

import {
  askJev,
  bool,
  BOOL_QUESTION_TYPE,
  choice,
  derivedConfidence,
  describeAnswers,
  JEV_MODEL,
  MAX_QUESTIONS,
  pick,
  scaleTo,
  score,
  yes,
  type Answers,
  type BoolAnswer,
  type ChoiceAnswer,
  type ScoreAnswer,
} from '~/lib/ai/jev';

/**
 * A stand-in for the Workers AI binding.
 *
 * `run` records what it was asked so the request shape can be asserted —
 * the wire contract is the one part of this that cannot be typechecked.
 */
function fakeAi(reply: unknown | (() => unknown)) {
  const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
  const ai = {
    run: vi.fn(async (model: string, body: Record<string, unknown>) => {
      calls.push({ model, body });
      return typeof reply === 'function' ? (reply as () => unknown)() : reply;
    }),
  };
  return { ai: ai as unknown as Ai, calls };
}

/** A usage context whose inserts go nowhere. Booking must never fail a call. */
const USAGE = {
  db: {
    insert: () => ({ values: async () => undefined }),
  } as never,
  userId: 'u1',
  operation: 'test',
};

const QUESTIONS = {
  refunded: bool('Was a refund issued?'),
  tone: choice('What tone?', { warm: 'friendly', curt: 'terse' }),
  quality: score('How well handled?', ['poor', 'acceptable', 'excellent']),
} as const;

const GOOD_REPLY = {
  refunded: { type: 'boolean', probability: 0.99 },
  tone: { type: 'choice', choice: 'warm', probabilities: { curt: 0.02, warm: 0.98 } },
  quality: { type: 'score', score: 1.78, probabilities: { '0': 0, '1': 0.22, '2': 0.78 } },
};

describe('building a request', () => {
  it('sends the model id and the state and questions as given', async () => {
    const { ai, calls } = fakeAi(GOOD_REPLY);
    await askJev(ai, 'a refund was issued', QUESTIONS, USAGE);

    expect(calls[0]!.model).toBe(JEV_MODEL);
    expect(calls[0]!.body.state).toBe('a refund was issued');
    expect(Object.keys(calls[0]!.body.questions as object)).toEqual(['refunded', 'tone', 'quality']);
  });

  it('passes a structured state through unflattened', async () => {
    // State may be an object, and structure is harder to misread than prose.
    const { ai, calls } = fakeAi(GOOD_REPLY);
    const state = { business: { name: 'Wells' }, images: 4 };
    await askJev(ai, state, QUESTIONS, USAGE);

    expect(calls[0]!.body.state).toEqual(state);
  });

  it('builds each question type in the shape the model expects', () => {
    expect(bool('q')).toEqual({ type: BOOL_QUESTION_TYPE, instructions: 'q' });
    expect(bool('q', { true: 'y', false: 'n' })).toEqual({
      type: BOOL_QUESTION_TYPE,
      instructions: 'q',
      criteria: { true: 'y', false: 'n' },
    });
    expect(choice('q', { a: 'A' })).toEqual({ type: 'choice', instructions: 'q', criteria: { a: 'A' } });
    expect(score('q', ['low', 'high'])).toEqual({
      type: 'score',
      instructions: 'q',
      criteria: ['low', 'high'],
    });
  });

  it('refuses a call with no questions, or with absurdly many', async () => {
    const { ai } = fakeAi(GOOD_REPLY);

    const none = await askJev(ai, 's', {}, USAGE);
    expect(none.ok).toBe(false);

    const many = Object.fromEntries(
      Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, bool('x')]),
    );
    const tooMany = await askJev(ai, 's', many, USAGE);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain('Too many');
  });
});

describe('reading a response', () => {
  it('returns every answer, typed to its question', async () => {
    const { ai } = fakeAi(GOOD_REPLY);
    const result = await askJev(ai, 's', QUESTIONS, USAGE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.refunded.probability).toBe(0.99);
    expect(result.data.tone.choice).toBe('warm');
    expect(result.data.quality.score).toBe(1.78);
  });

  it('turns a score into a fraction and the nearest level', async () => {
    const { ai } = fakeAi(GOOD_REPLY);
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    // 1.78 of a 0..2 scale.
    expect(result.data.quality.fraction).toBeCloseTo(0.89, 2);
    expect(result.data.quality.level).toBe('excellent');
  });

  it('fills in a probability the response left out rather than leaving it undefined', async () => {
    const { ai } = fakeAi({
      ...GOOD_REPLY,
      tone: { type: 'choice', choice: 'warm', probabilities: { warm: 0.9 } },
    });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.tone.probabilities.curt).toBe(0);
  });

  it('accepts answers nested under the shapes the surfaces return', async () => {
    for (const wrapper of [
      { answers: GOOD_REPLY },
      { result: GOOD_REPLY },
      GOOD_REPLY,
    ]) {
      const { ai } = fakeAi(wrapper);
      const result = await askJev(ai, 's', QUESTIONS, USAGE);
      expect(result.ok).toBe(true);
    }
  });

  it('takes a reported confidence over a derived one', async () => {
    const { ai } = fakeAi({
      ...GOOD_REPLY,
      tone: { type: 'choice', choice: 'warm', probabilities: { curt: 0.5, warm: 0.5 }, confidence: 0.91 },
    });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.tone.confidence).toBe(0.91);
    expect(result.data.tone.confidenceSource).toBe('reported');
  });

  it('reads a confidence out of provider metadata, keyed by question', async () => {
    const { ai } = fakeAi({
      answers: GOOD_REPLY,
      providerMetadata: { typesafe: { confidence: { tone: 0.77 } } },
    });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.tone.confidence).toBe(0.77);
    expect(result.data.tone.confidenceSource).toBe('reported');
  });

  it('derives a confidence when none is reported, and says that it did', async () => {
    const { ai } = fakeAi(GOOD_REPLY);
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.tone.confidenceSource).toBe('derived');
    // 0.98/0.02 is a concentrated distribution.
    expect(result.data.tone.confidence).toBeGreaterThan(0.8);
  });
});

describe('refusing a response it cannot stand behind', () => {
  it('fails the call when a choice is outside the criteria', async () => {
    // The closed set is the entire value of the type; coercing here would
    // hand a caller a value its own switch cannot handle.
    const { ai } = fakeAi({
      ...GOOD_REPLY,
      tone: { type: 'choice', choice: 'sarcastic', probabilities: {} },
    });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tone');
      expect(result.error).toContain('sarcastic');
    }
  });

  it('fails the call when an answer is missing entirely', async () => {
    const { ai } = fakeAi({ refunded: GOOD_REPLY.refunded, tone: GOOD_REPLY.tone });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('quality');
  });

  it('never returns a partial answer set', async () => {
    // The inferred type promises every key, so a half-answer must not be
    // handed back as though it were complete.
    const { ai } = fakeAi({ refunded: { type: 'boolean', probability: 0.5 } });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    expect(result.ok).toBe(false);
  });

  it('clamps a score a hair outside its scale rather than failing', async () => {
    const { ai } = fakeAi({
      ...GOOD_REPLY,
      quality: { type: 'score', score: 2.0001, probabilities: {} },
    });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.quality.score).toBe(2);
    expect(result.data.quality.fraction).toBe(1);
  });

  it('clamps a probability outside 0..1', async () => {
    const { ai } = fakeAi({ ...GOOD_REPLY, refunded: { type: 'boolean', probability: 4 } });
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    expect(result.data.refunded.probability).toBe(1);
  });

  it('survives a response that is not an object at all', async () => {
    for (const reply of [null, undefined, 'a string', 42, []]) {
      const { ai } = fakeAi(reply);
      const result = await askJev(ai, 's', QUESTIONS, USAGE);
      expect(result.ok).toBe(false);
    }
  });

  it('returns the transport failure rather than throwing', async () => {
    const ai = { run: async () => { throw new Error('model not available on this account'); } };
    const result = await askJev(ai as unknown as Ai, 's', QUESTIONS, USAGE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not available');
  });

  it('gives up rather than hanging when the model never answers', async () => {
    const ai = { run: () => new Promise(() => {}) };
    const result = await askJev(ai as unknown as Ai, 's', QUESTIONS, USAGE, { timeoutMs: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });

  it('still answers when booking the call on the ledger fails', async () => {
    // Observability must never be the thing that breaks a run.
    const { ai } = fakeAi(GOOD_REPLY);
    const broken = {
      ...USAGE,
      db: { insert: () => { throw new Error('no such table'); } } as never,
    };

    const result = await askJev(ai, 's', QUESTIONS, broken);
    expect(result.ok).toBe(true);
  });
});

describe('reading answers', () => {
  const boolAnswer: BoolAnswer = { type: 'boolean', probability: 0.7 };
  const choiceAnswer: ChoiceAnswer<'a' | 'b'> = {
    type: 'choice',
    choice: 'a',
    probabilities: { a: 0.8, b: 0.2 },
    confidence: 0.6,
    confidenceSource: 'reported',
  };

  it('reads a boolean at a threshold', () => {
    expect(yes(boolAnswer)).toBe(true);
    expect(yes(boolAnswer, 0.8)).toBe(false);
  });

  it('withholds a choice the model was not confident about', () => {
    expect(pick(choiceAnswer, 0.4)).toBe('a');
    expect(pick(choiceAnswer, 0.9)).toBeNull();
  });

  it('maps a score onto a numeric range', () => {
    const answer: ScoreAnswer = {
      type: 'score',
      score: 2,
      fraction: 0.5,
      level: 'mid',
      probabilities: {},
      confidence: 1,
      confidenceSource: 'reported',
    };

    expect(scaleTo(answer, 0, 100)).toBe(50);
    expect(scaleTo(answer, 20, 40)).toBe(30);
  });

  it('scores a concentrated distribution as confident and a flat one as not', () => {
    expect(derivedConfidence([0.99, 0.01])).toBeGreaterThan(0.9);
    expect(derivedConfidence([0.5, 0.5])).toBeCloseTo(0, 5);
    expect(derivedConfidence([0.34, 0.33, 0.33])).toBeLessThan(0.05);
    // Degenerate inputs must not produce NaN: these end up in log lines.
    expect(derivedConfidence([])).toBe(0);
    expect(derivedConfidence([1])).toBe(0);
    expect(derivedConfidence([0, 0])).toBe(0);
  });

  it('writes a decision out in words, with how sure it was', async () => {
    const { ai } = fakeAi(GOOD_REPLY);
    const result = await askJev(ai, 's', QUESTIONS, USAGE);
    if (!result.ok) throw new Error('expected an answer');

    const described = describeAnswers(result.data as unknown as Record<string, unknown>);
    expect(described).toContain('tone: warm');
    expect(described).toContain('quality: excellent');
    expect(described).toContain('refunded: yes');
    // A derived confidence is labelled as such wherever it is shown.
    expect(described).toContain('derived');
  });
});

describe('the inferred types', () => {
  it('narrows a choice to its own options', () => {
    type A = Answers<typeof QUESTIONS>;
    // A compile-time assertion: this only builds if `choice` is the union.
    const widen = (value: 'warm' | 'curt'): string => value;
    const answer = { choice: 'warm' } as A['tone'];
    expect(widen(answer.choice)).toBe('warm');
  });
});
