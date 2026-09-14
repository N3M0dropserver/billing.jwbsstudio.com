/**
 * Turning what a run did into what to change.
 *
 * Every case here is drawn from the run that prompted this work: ten demos
 * built for businesses with no website, every qualify call failing, four
 * plans falling back to a scaffold, and no photography anywhere.
 *
 * The bar each recommendation has to clear is that it names a number from a
 * real run and one thing to do about it. A test that only checks "something
 * was suggested" would pass for a page full of platitudes, so these check
 * which suggestion, and that the quiet cases stay quiet.
 */

import { describe, expect, it } from 'vitest';
import { applyDismissals, recommend, type RunSignals } from '~/lib/growth/recommend';

function signals(overrides: Partial<RunSignals> = {}): RunSignals {
  return {
    runs: 1,
    calls: [],
    warnings: [],
    builtCount: 0,
    builtWithoutImages: 0,
    selectedCount: 0,
    selectedWithEmail: 0,
    selectedWithoutWebsite: 0,
    settings: {
      generateDemoImages: true,
      maxGeneratedImages: 3,
      discoveryProvider: 'google-places',
      placesKeySet: true,
      outreachDailyCap: 5,
      aiCacheTtlHours: 72,
      demoHostVerified: true,
    },
    draftedProposals: 0,
    ...overrides,
  };
}

const ids = (s: RunSignals) => recommend(s).map((rec) => rec.id);

describe('a healthy run', () => {
  it('suggests nothing', () => {
    expect(recommend(signals())).toEqual([]);
  });

  it('stays quiet on a first run with no history', () => {
    expect(recommend(signals({ runs: 0 }))).toEqual([]);
  });
});

describe('failing model calls', () => {
  /** The run that prompted this: every qualify call threw, so fit was 0. */
  it('is reported, and says what a failed judgement costs', () => {
    const found = recommend(
      signals({ calls: [{ operation: 'qualify', total: 40, failed: 40 }] }),
    );

    expect(found[0]?.id).toBe('model-calls-failing:qualify');
    expect(found[0]?.severity).toBe('blocking');
    expect(found[0]?.detail).toContain('40 of 40');
    expect(found[0]?.detail).toContain('fit 0');
  });

  it('ignores the odd failure', () => {
    expect(ids(signals({ calls: [{ operation: 'plan', total: 40, failed: 2 }] }))).toEqual([]);
  });

  it('does not fire on too small a sample to mean anything', () => {
    expect(ids(signals({ calls: [{ operation: 'plan', total: 2, failed: 2 }] }))).toEqual([]);
  });
});

describe('plans falling back to scaffolds', () => {
  it('is reported when it is a fifth of the run or more', () => {
    const found = ids(signals({ warnings: [{ stage: 'plan', count: 4 }], builtCount: 10 }));
    expect(found).toContain('plans-scaffolded');
  });

  it('is not reported for one bad plan in twenty', () => {
    expect(ids(signals({ warnings: [{ stage: 'plan', count: 1 }], builtCount: 20 }))).not.toContain(
      'plans-scaffolded',
    );
  });
});

describe('demos with no photography', () => {
  const bare = { builtCount: 10, builtWithoutImages: 10 };

  it('names the real problem when there is no source and no generation', () => {
    const found = recommend(
      signals({
        ...bare,
        settings: { ...signals().settings, generateDemoImages: false, discoveryProvider: 'overpass' },
      }),
    );

    const rec = found.find((r) => r.id === 'no-photography:nowhere-to-get-it');
    expect(rec).toBeDefined();
    expect(rec?.detail).toContain('10 of 10');
    expect(rec?.action).toContain('Google Places');
  });

  it('says so when generation is on but nothing real can reach a page', () => {
    expect(
      ids(signals({ ...bare, settings: { ...signals().settings, discoveryProvider: 'overpass' } })),
    ).toContain('no-photography:no-real-source');
  });

  it('asks only for generation when the source is already right', () => {
    expect(
      ids(signals({ ...bare, settings: { ...signals().settings, generateDemoImages: false } })),
    ).toContain('no-photography:generation-off');
  });

  it('stays quiet when most demos did get pictures', () => {
    expect(ids(signals({ builtCount: 10, builtWithoutImages: 2 }))).toEqual([]);
  });
});

describe('settings that will simply fail', () => {
  it('catches Places selected with no key', () => {
    const found = recommend(
      signals({ settings: { ...signals().settings, placesKeySet: false } }),
    );
    expect(found[0]?.id).toBe('places-key-missing');
    expect(found[0]?.severity).toBe('blocking');
  });
});

describe('prospects with nowhere to send an email', () => {
  it('is reported, and blames the right thing when they have no websites', () => {
    const found = recommend(
      signals({ selectedCount: 10, selectedWithEmail: 0, selectedWithoutWebsite: 10 }),
    );

    const rec = found.find((r) => r.id === 'no-email-to-write-to');
    expect(rec?.detail).toContain('10 of 10');
    expect(rec?.action).toContain('no website');
  });

  it('blames the crawl when they do have websites', () => {
    const found = recommend(
      signals({ selectedCount: 10, selectedWithEmail: 1, selectedWithoutWebsite: 0 }),
    );
    expect(found.find((r) => r.id === 'no-email-to-write-to')?.action).toContain('crawl');
  });
});

describe('ordering', () => {
  it('puts what is broken above what is merely untidy', () => {
    const found = recommend(
      signals({
        calls: [{ operation: 'qualify', total: 10, failed: 10 }],
        settings: { ...signals().settings, aiCacheTtlHours: 0 },
        runs: 4,
      }),
    );

    expect(found[0]?.severity).toBe('blocking');
    expect(found[found.length - 1]?.severity).toBe('opportunity');
  });
});

describe('dismissals', () => {
  const found = () => recommend(signals({ calls: [{ operation: 'qualify', total: 10, failed: 10 }] }));

  it('hides one waved away at the same numbers', () => {
    const kept = applyDismissals(found(), [
      { recommendationId: 'model-calls-failing:qualify', signature: '10/10' },
    ]);
    expect(kept).toEqual([]);
  });

  /** A decision about ten failures is not a decision about forty. */
  it('brings it back when the numbers change', () => {
    const kept = applyDismissals(found(), [
      { recommendationId: 'model-calls-failing:qualify', signature: '2/10' },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('leaves everything else alone', () => {
    const kept = applyDismissals(found(), [{ recommendationId: 'something-else', signature: 'x' }]);
    expect(kept).toHaveLength(1);
  });
});

describe('every recommendation', () => {
  /**
   * The bar: a number from a real run, one thing to do, and somewhere to do
   * it. Anything that cannot manage all three is an opinion.
   */
  it('names evidence, an action and a destination', () => {
    const everything = recommend(
      signals({
        runs: 5,
        calls: [{ operation: 'qualify', total: 10, failed: 10 }],
        warnings: [{ stage: 'plan', count: 5 }],
        builtCount: 10,
        builtWithoutImages: 10,
        selectedCount: 10,
        selectedWithEmail: 0,
        selectedWithoutWebsite: 10,
        draftedProposals: 6,
        settings: {
          generateDemoImages: false,
          maxGeneratedImages: 0,
          discoveryProvider: 'overpass',
          placesKeySet: false,
          outreachDailyCap: 0,
          aiCacheTtlHours: 0,
          demoHostVerified: false,
        },
      }),
    );

    expect(everything.length).toBeGreaterThan(5);

    for (const rec of everything) {
      expect(rec.id).toBeTruthy();
      expect(rec.title).toBeTruthy();
      expect(rec.detail.length).toBeGreaterThan(20);
      expect(rec.action.length).toBeGreaterThan(20);
      expect(rec.href.startsWith('/')).toBe(true);
      expect(rec.linkLabel).toBeTruthy();
      expect(rec.signature).toBeTruthy();
    }

    // Ids are what dismissals key on, so they must not collide.
    const seen = everything.map((rec) => rec.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
