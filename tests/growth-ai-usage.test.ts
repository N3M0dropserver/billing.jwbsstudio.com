import { describe, expect, it } from 'vitest';
import {
  CENTS_PER_1K_NEURONS,
  costMicrocents,
  estimateTokens,
  formatCost,
  MODEL_PRICING,
  priceFor,
  UNKNOWN_MODEL_PRICE,
} from '~/lib/ai/pricing';
import { requestHash } from '~/lib/ai/usage';

describe('pricing', () => {
  it('is honest about which rates are confirmed', () => {
    // Every rate here is derived rather than published. The dashboard reads
    // this flag to label its totals; a rate silently marked confident would
    // turn an estimate into a claim.
    for (const [model, price] of Object.entries(MODEL_PRICING)) {
      expect(price.note.toLowerCase()).toContain('verify');
      expect(price.confident, `${model} claims confidence it does not have`).toBe(false);
    }
    expect(CENTS_PER_1K_NEURONS).toBeGreaterThan(0);
  });

  it('prices an unknown model pessimistically rather than free', () => {
    const price = priceFor('@cf/some/model-we-have-never-seen');
    expect(price).toEqual(UNKNOWN_MODEL_PRICE);
    expect(price.inputCentsPerMillion).toBeGreaterThan(0);
    expect(price.confident).toBe(false);
  });

  it('costs output at least as dearly as input', () => {
    for (const price of [...Object.values(MODEL_PRICING), UNKNOWN_MODEL_PRICE]) {
      expect(price.outputCentsPerMillion).toBeGreaterThanOrEqual(price.inputCentsPerMillion);
    }
  });

  it('returns whole microcents so totals stay exact when summed', () => {
    const { microcents } = costMicrocents('@cf/meta/llama-3.1-8b-instruct', 1234, 567);
    expect(Number.isInteger(microcents)).toBe(true);
    expect(microcents).toBeGreaterThan(0);
  });

  it('charges nothing for nothing', () => {
    expect(costMicrocents('@cf/meta/llama-3.1-8b-instruct', 0, 0).microcents).toBe(0);
  });

  it('scales linearly with tokens', () => {
    const one = costMicrocents('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 1000, 1000).microcents;
    const ten = costMicrocents('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 10_000, 10_000).microcents;
    expect(ten).toBe(one * 10);
  });

  it('reports whether the figure can be trusted', () => {
    expect(costMicrocents('@cf/meta/llama-3.1-8b-instruct', 100, 100).confident).toBe(false);
  });
});

describe('formatting cost', () => {
  it('reads as money at every magnitude', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(5_000_000)).toBe('$0.05');
    expect(formatCost(500_000)).toBe('0.50c');
    expect(formatCost(1)).toBe('<0.01c');
  });
});

describe('token estimation', () => {
  it('is roughly four characters to a token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('hi')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('')).toBe(1);
  });
});

describe('the cache key', () => {
  const base = { system: 'be brief', prompt: 'hello', model: 'm', maxTokens: 100, temperature: 0.2 };

  it('is stable for an identical request', async () => {
    expect(await requestHash(base)).toBe(await requestHash({ ...base }));
  });

  it('changes when anything that changes the answer changes', async () => {
    const original = await requestHash(base);
    for (const change of [
      { system: 'be verbose' },
      { prompt: 'goodbye' },
      { model: 'other' },
      { maxTokens: 200 },
      { temperature: 0.9 },
    ]) {
      expect(await requestHash({ ...base, ...change })).not.toBe(original);
    }
  });

  it('treats an omitted parameter the same as its default', async () => {
    // Otherwise a call that relies on the default never hits a cached entry
    // written by one that spelled it out.
    const spelled = await requestHash({ system: 's', prompt: 'p', maxTokens: 1024, temperature: 0.7 });
    const omitted = await requestHash({ system: 's', prompt: 'p' });
    expect(omitted).toBe(spelled);
  });

  it('is a full SHA-256 in hex', async () => {
    expect(await requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
