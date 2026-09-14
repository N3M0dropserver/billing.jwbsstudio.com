import { describe, expect, it } from 'vitest';
import { cosine, parseVector, serialiseVector } from '~/lib/ai/embed';
import { keywordOverlap, renderMemories, scoreMemory, tokenise } from '~/lib/agent/memory';
import type { AgentMemory } from '~/lib/db/schema';

function memoryOf(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id: 'mem_1',
    userId: 'user_1',
    scope: 'global',
    scopeKey: '',
    kind: 'lesson',
    content: 'Physiotherapy clinics almost never publish their prices.',
    tags: '["physiotherapy","pricing"]',
    source: 'reflection',
    campaignId: null,
    prospectId: null,
    confidence: 60,
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    embedding: '',
    embeddingModel: '',
    retiredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentMemory;
}

describe('vectors', () => {
  it('scores identical vectors as one and opposite ones as minus one', () => {
    expect(cosine([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('scores zero rather than throwing when the model has changed', () => {
    // A shorter vector means these rows were written by a different embedding
    // model. The memory should stop matching, not break recall for every
    // other one.
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it('survives a round trip, rounded', () => {
    const vector = [0.123456, -0.9876543, 0];
    const restored = parseVector(serialiseVector(vector));
    expect(restored).toEqual([0.1235, -0.9877, 0]);
  });

  it('treats a missing or malformed vector as no vector', () => {
    expect(parseVector('')).toEqual([]);
    expect(parseVector('not json')).toEqual([]);
    expect(parseVector('["a"]')).toEqual([]);
  });
});

describe('keyword matching', () => {
  it('measures overlap as a fraction of the question', () => {
    // A long memory containing every word of a short question is a good
    // match; scoring against its own length would bury it.
    const query = tokenise('physiotherapy prices');
    const target = tokenise(`Physiotherapy clinics and their prices, at length. ${'padding '.repeat(30)}`);
    expect(keywordOverlap(query, target)).toBe(1);
  });

  it('drops the words that match everything', () => {
    expect(tokenise('the and for with a business')).toHaveLength(1);
  });

  it('brings a trade and its practitioners to the same stem', () => {
    // Without this the fallback path misses the memory written about exactly
    // this trade, which is the case it exists for.
    const [trade] = tokenise('physiotherapy');
    const [practitioner] = tokenise('physiotherapists');
    expect(trade).toBe(practitioner);
    expect(tokenise('roaster')[0]).toBe(tokenise('roasters')[0]);
  });
});

describe('scoring a memory against a task', () => {
  const task = 'plan a site for a physiotherapist in Lower Hutt';

  it('prefers meaning over words when an embedding is available', () => {
    const scored = scoreMemory(
      memoryOf({ embedding: JSON.stringify([1, 0, 0]) }),
      { vector: [1, 0, 0], queryTokens: ['nothing', 'alike'], scopes: [] },
    );

    expect(scored.matchedBy).toBe('embedding');
    expect(scored.score).toBeGreaterThan(50);
  });

  it('falls back to words when there is no embedding', () => {
    const scored = scoreMemory(memoryOf(), {
      vector: null,
      queryTokens: tokenise(task),
      scopes: [],
    });

    expect(scored.matchedBy).toBe('keyword');
    expect(scored.score).toBeGreaterThan(0);
  });

  it('keeps a memory scoped to exactly this job even when the words do not match', () => {
    const scored = scoreMemory(
      memoryOf({ scope: 'prospect', scopeKey: 'prospect_9', content: 'Sam prefers to be emailed in the evening.' }),
      { vector: null, queryTokens: tokenise('write the outreach'), scopes: [{ scope: 'prospect', key: 'Prospect_9' }] },
    );

    expect(scored.score).toBeGreaterThan(0);
  });

  it('always offers a pinned memory', () => {
    const scored = scoreMemory(memoryOf({ pinned: true, content: 'Never use the word bespoke.' }), {
      vector: null,
      queryTokens: tokenise('something entirely unrelated'),
      scopes: [],
    });

    expect(scored.score).toBeGreaterThan(0);
  });

  it('drops an unpinned memory with nothing in common', () => {
    const scored = scoreMemory(memoryOf(), {
      vector: null,
      queryTokens: tokenise('invoice reminders overdue'),
      scopes: [],
    });

    expect(scored.score).toBe(0);
  });

  it('lets confidence and a track record break a tie', () => {
    const base = { vector: null, queryTokens: tokenise(task), scopes: [] };
    const weak = scoreMemory(memoryOf({ confidence: 20 }), base);
    const strong = scoreMemory(memoryOf({ confidence: 95, useCount: 5 }), base);
    expect(strong.score).toBeGreaterThan(weak.score);
  });
});

describe('rendering memories for a prompt', () => {
  it('presents them as recollections rather than rules', () => {
    const rendered = renderMemories([
      { memory: memoryOf({ scope: 'niche', scopeKey: 'physiotherapists' }), score: 10, matchedBy: 'keyword' },
    ]);

    expect(rendered).toContain('recollections, not rules');
    expect(rendered).toContain('believe what is in front of you');
    expect(rendered).toContain('(niche: physiotherapists)');
  });

  it('renders nothing when there is nothing', () => {
    expect(renderMemories([])).toBe('');
  });
});
