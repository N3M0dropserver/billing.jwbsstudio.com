/**
 * The lead filter, judged on whole searches rather than on one number.
 *
 * These run the real `auditSite`, `assessScale`, `qualifyProspect` and gate
 * logic over fixed businesses whose right answer a person has written down.
 * A weight can be changed and the effect read as "this business stopped being
 * a lead", which is the only form in which the effect is worth arguing about.
 *
 * The adversarial passes matter more than the ordinary one. The pipeline's
 * job is not to be right when the model is right — it is to be safe when the
 * model is wrong, because the cost of being wrong lands in a stranger's
 * inbox.
 */

import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from './scenarios/fixtures';
import { assessOne, runScenario, type Scenario } from './scenarios/harness';

describe.each(SCENARIOS)('$id', (scenario) => {
  it('finds every lead worth finding and writes to nobody it should not', async () => {
    const run = await runScenario(scenario, 'scripted');

    expect(run.falsePositives.map((a) => `${a.name}: ${a.why}`)).toEqual([]);
    expect(run.falseNegatives.map((a) => `${a.name}: ${a.why}`)).toEqual([]);
  });

  it('holds when the model likes everybody', async () => {
    // The documented historical failure: a model that answers "yes, they can
    // afford it" to every question. Nothing it says may admit a business the
    // measurements rule out.
    const run = await runScenario(scenario, 'optimistic');
    expect(run.falsePositives.map((a) => `${a.name}: ${a.why}`)).toEqual([]);
  });

  it('admits nobody when the model cannot be reached', async () => {
    // A dead model is allowed to cost leads. It is not allowed to produce them.
    const run = await runScenario(scenario, 'broken');
    expect(run.falsePositives.map((a) => `${a.name}: ${a.why}`)).toEqual([]);
  });

  it('never selects a business it has no way of writing to', async () => {
    for (const mode of ['scripted', 'optimistic', 'broken'] as const) {
      const run = await runScenario(scenario, mode);
      expect(
        run.selected.filter((a) => !a.contactable).map((a) => a.name),
        `${scenario.id} under ${mode}`,
      ).toEqual([]);
    }
  });

  it('never selects a business with nothing measurable to open an email with', async () => {
    for (const mode of ['scripted', 'optimistic'] as const) {
      const run = await runScenario(scenario, mode);
      expect(
        run.selected.filter((a) => a.audit.observations.length === 0).map((a) => a.name),
        `${scenario.id} under ${mode}`,
      ).toEqual([]);
    }
  });

  it('does not pay for an opinion it cannot act on', async () => {
    const run = await runScenario(scenario, 'scripted');
    for (const row of run.assessments) {
      if (!row.modelCalled) continue;
      expect(row.scaleScore, `${row.name} was asked about despite its size`).toBeLessThanOrEqual(
        scenario.scaleCeiling,
      );
      expect(row.contactable, `${row.name} was asked about with nowhere to send anything`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The individual guards, each with the failure it was added for       */
/* ------------------------------------------------------------------ */

const BENCH: Scenario = {
  id: 'guards',
  niche: 'jeweller',
  region: 'Nelson',
  country: 'NZ',
  idealClient: '',
  targetCount: 3,
  scoreFloor: 55,
  scaleCeiling: 60,
  businesses: [],
};

const NEGLECTED = `<html><head><title>Home</title></head>
<body bgcolor="#fff"><center><font size="4">Welcome</font></center>
<p>Call us.</p><footer>Copyright 2013</footer></body></html>`;

describe('a chain the model never got to see', () => {
  const chain = {
    name: 'Catalogued Chain',
    want: 'reject' as const,
    why: 'Wikidata says it is a chain, and the site is neglected enough to score well on need.',
    osm: { website: 'https://chain.test/', email: 'x@chain.test', reviewCount: 200 },
    html: NEGLECTED,
    wikidata: { id: 'Q999', description: 'retail chain' },
    model: { fit: 70 },
  };

  it('stays ruled out when the model answers', async () => {
    const assessment = await assessOne(BENCH, chain, 'scripted');
    expect(assessment.scale.decisive).toBe(true);
    expect(assessment.skip).toBe(true);
    expect(assessment.eligible).toBe(false);
  });

  it('stays ruled out when the model cannot be reached', async () => {
    // The original hole: `skip` came only from the model, so a failed call
    // left a catalogued chain ranked on need alone — a need of 100, which
    // clears the floor on its own.
    const assessment = await assessOne(BENCH, chain, 'broken');
    expect(assessment.presenceScore).toBeGreaterThan(90);
    expect(assessment.skip).toBe(true);
    expect(assessment.eligible).toBe(false);
    expect(assessment.ruledOutBy).toBe('decisive-scale');
  });
});

describe('a business with nowhere to send anything', () => {
  const unreachable = {
    name: 'Frankton Plumbing',
    want: 'reject' as const,
    why: 'No website, no email. Maximum need and no way to act on it.',
    osm: { mapsUrl: 'https://www.openstreetmap.org/node/2', reviewCount: 6 },
    html: null,
    model: { fit: 85 },
  };

  it('is ruled out before a model call is paid for', async () => {
    const assessment = await assessOne(BENCH, unreachable, 'optimistic');
    expect(assessment.presenceScore).toBeGreaterThan(90);
    expect(assessment.contactable).toBe(false);
    expect(assessment.modelCalled).toBe(false);
    expect(assessment.eligible).toBe(false);
    expect(assessment.ruledOutBy).toBe('unreachable');
  });

  it('is kept when the directory published an address, even with no site', async () => {
    // The distinction that matters: no website is the pitch, no route to a
    // person is the disqualification.
    const assessment = await assessOne(
      BENCH,
      { ...unreachable, want: 'lead', osm: { ...unreachable.osm, email: 'owner@frankton.test' } },
      'scripted',
    );
    expect(assessment.contactable).toBe(true);
    expect(assessment.eligible).toBe(true);
  });
});

describe('a business whose site is fine', () => {
  const fine = {
    name: 'Bell & Bray',
    want: 'reject' as const,
    why: 'Nothing measurable is wrong. Writing to them means inventing a problem.',
    osm: { website: 'https://bellbray.test/', email: 'hello@bellbray.test', reviewCount: 130 },
    html: `<!doctype html><html lang="en"><head><title>Bell &amp; Bray — physiotherapy in Geelong</title>
<meta name="description" content="Physiotherapy in Geelong." />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" /></head><body><h1>Bell &amp; Bray</h1>
<p>${'We treat backs and shoulders every weekday morning. '.repeat(20)}</p>
<img src="/clinic.jpg" alt="The clinic" />
<a href="mailto:hello@bellbray.test">hello@bellbray.test</a>
<a href="https://instagram.com/bellbray">Instagram</a>
<footer>© 2026 Bell &amp; Bray</footer></body></html>`,
    model: { fit: 90 },
  };

  it('costs nothing to reject, because no fit could save it', async () => {
    const assessment = await assessOne(BENCH, fine, 'optimistic');
    expect(assessment.audit.observations).toEqual([]);
    expect(assessment.modelCalled).toBe(false);
    expect(assessment.ruledOutBy).toBe('no-honest-angle');
  });
});

describe('a floor of zero', () => {
  it('does not turn every rejected prospect back into a candidate', async () => {
    // `skip` used to be expressed only as a score of zero, which a floor of
    // zero — a setting the form allows — silently undid.
    const open = { ...scenarioById('napier-cafe'), scoreFloor: 0 };
    const run = await runScenario(open, 'scripted');

    expect(run.falsePositives.map((a) => a.name)).toEqual([]);
    expect(run.selected.every((a) => !a.skip)).toBe(true);
  });
});

describe('what the model is shown', () => {
  it('fences the prospect\'s own copy and says it is not an instruction', async () => {
    const run = await runScenario(scenarioById('napier-cafe'), 'scripted');
    const prompt = run.prompts[0]!.prompt;

    expect(prompt).toContain('<their-site>');
    expect(prompt).toContain('ignore');
  });

  it('gives it measurements rather than adjectives', async () => {
    const run = await runScenario(scenarioById('napier-cafe'), 'scripted');
    const prompt = run.prompts[0]!.prompt;

    expect(prompt).toContain('presence_score:');
    expect(prompt).toContain('scale_score:');
  });
});
