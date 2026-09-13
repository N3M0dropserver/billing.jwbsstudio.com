/**
 * A bench for the lead-selection half of the growth pipeline.
 *
 * The engine's decision about who is worth writing to is spread over four
 * places — `auditSite`, `assessScale`, `qualifyProspect` and the gate in
 * `stageShortlist` — and none of them can be judged alone. This runs the real
 * functions, in the real order, over fixed businesses, so a change to a
 * weight can be read as "these two stopped being leads" rather than as a
 * number moving.
 *
 * Nothing here re-implements scoring. Every figure comes from the module the
 * engine calls; the only thing this file owns is the orchestration and the
 * stand-in for the model.
 */

import { auditSite, combineScores, type SiteAudit } from '~/lib/growth/assess';
import { extractPage } from '~/lib/growth/html';
import { capFitToScale, qualifyProspect, type Qualification } from '~/lib/growth/qualify';
import { assessScale, type ScaleAssessment } from '~/lib/growth/scale';
import { EMPTY_PROMINENCE, type ProminenceResult } from '~/lib/growth/search';
import type { CrawlResult } from '~/lib/growth/crawl';
import type { Db } from '~/lib/db/index';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export interface BusinessFixture {
  name: string;
  /** What this business should be, so a run can be marked right or wrong. */
  want: 'lead' | 'reject';
  /** Why, in the words you would use defending the call to someone. */
  why: string;
  /** What the directory knew. Mirrors OpenStreetMap's tags. */
  osm?: {
    website?: string;
    email?: string;
    phone?: string;
    /** Published trading hours, the cheapest evidence anyone is there. */
    openingHours?: string;
    mapsUrl?: string;
    brand?: string;
    brandWikidata?: string;
    operator?: string;
    branchCount?: number;
    reviewCount?: number;
    context?: string;
  };
  /** Their home page. `null` means there is nothing to fetch. */
  html?: string | null;
  /** The site answered at all. False models a dead domain. */
  reachable?: boolean;
  httpsWorks?: boolean;
  /** A catalogued entity was found looking them up outside their own site. */
  wikidata?: { id: string; description: string };
  /** What a reasonable model would return for this business. */
  model?: { fit: number; skip?: boolean; tooBig?: boolean; angle?: string };
}

export interface Scenario {
  id: string;
  /** The search, as the user would type it. */
  niche: string;
  region: string;
  country: 'NZ' | 'AU';
  idealClient: string;
  targetCount: number;
  scoreFloor: number;
  scaleCeiling: number;
  businesses: BusinessFixture[];
}

/** How the stand-in model behaves, so the guards can be tested without it. */
export type ModelMode =
  /** Each fixture's own `model` block — a model that is doing its job. */
  | 'scripted'
  /** Everything is a great prospect. The documented historical failure. */
  | 'optimistic'
  /** Nothing is. Proves nothing survives on measurement alone. */
  | 'pessimistic'
  /** Every call fails. Proves a dead model does not admit bad leads. */
  | 'broken';

/* ------------------------------------------------------------------ */
/* Stand-ins                                                           */
/* ------------------------------------------------------------------ */

/**
 * A database that is not there.
 *
 * `trackedGenerateJson` books usage against one, and every one of those
 * writes is already wrapped so that observability cannot fail a run. This
 * leans on that rather than pretending to be D1.
 */
const NO_DB = {
  insert() {
    throw new Error('no database in the bench');
  },
  select() {
    throw new Error('no database in the bench');
  },
} as unknown as Db;

export interface PromptRecord {
  system: string;
  prompt: string;
}

/** A model that answers from the fixture, and keeps what it was asked. */
export function fakeAi(
  reply: (prompt: string) => Record<string, unknown> | null,
  seen: PromptRecord[] = [],
): Ai {
  return {
    async run(_model: unknown, input: unknown) {
      const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
      seen.push({ system, prompt });

      const answer = reply(prompt);
      if (!answer) throw new Error('the model is unavailable');
      return { response: JSON.stringify(answer) };
    },
  } as unknown as Ai;
}

/** Build a crawl result from a page of HTML, the way the crawler would. */
export function crawlOf(
  business: BusinessFixture,
  url: string,
  pagesRequested = 1,
): CrawlResult | null {
  if (!business.osm?.website) return null;
  if (business.reachable === false) {
    return {
      root: url,
      pagesRequested,
      reachable: false,
      httpsWorks: false,
      robotsFound: false,
      disallowed: [],
      pages: [],
      socials: [],
      emails: [],
      phones: [],
      images: [],
      error: 'connection refused',
    };
  }

  const html = business.html ?? '';
  const extracted = extractPage(html, url);

  return {
    root: url,
    pagesRequested,
    reachable: true,
    httpsWorks: business.httpsWorks !== false,
    robotsFound: true,
    disallowed: [],
    pages: [
      {
        url,
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        bytes: html.length,
        elapsedMs: 400,
        html,
        truncated: false,
        extracted,
      },
    ],
    socials: extracted.links
      .filter((link) => /facebook|instagram|linkedin|tiktok/i.test(link.href))
      .map((link) => ({
        platform: (link.href.match(/facebook|instagram|linkedin|tiktok/i)?.[0] ?? '').toLowerCase(),
        url: link.href,
        handle: '',
      })),
    emails: extracted.links
      .filter((link) => link.href.startsWith('mailto:'))
      .map((link) => link.href.slice(7)),
    phones: [],
    images: extracted.images.map((image) => image.src),
  };
}

/* ------------------------------------------------------------------ */
/* One prospect through the gate                                       */
/* ------------------------------------------------------------------ */

export interface Assessment {
  name: string;
  want: BusinessFixture['want'];
  why: string;
  audit: SiteAudit;
  scale: ScaleAssessment;
  /** The model was actually paid for. False when measurement settled it. */
  modelCalled: boolean;
  /** What the model said before the scale ceiling was applied in code. */
  modelFit: number;
  qualification: Qualification | null;
  fitScore: number;
  presenceScore: number;
  scaleScore: number;
  score: number;
  skip: boolean;
  /** Why this one is not going forward, when it is not. */
  ruledOutBy:
    | 'scale-ceiling'
    | 'decisive-scale'
    | 'unreachable'
    | 'no-honest-angle'
    | 'model-skip'
    | 'score-floor'
    | null;
  /** Whether it survived to the shortlist's ranking. */
  eligible: boolean;
  /** Whether it was actually picked. Set by `runScenario`. */
  selected: boolean;
  /** True when a business with no route to contact them got through. */
  contactable: boolean;
}

function scriptedReply(business: BusinessFixture, mode: ModelMode): Record<string, unknown> | null {
  if (mode === 'broken') return null;

  const scripted = business.model ?? { fit: 50 };
  const fit =
    mode === 'optimistic' ? 85 : mode === 'pessimistic' ? 10 : scripted.fit;
  const skip = mode === 'optimistic' ? false : mode === 'pessimistic' ? true : (scripted.skip ?? false);

  return {
    fit_score: fit,
    reasoning: `bench: ${business.why}`,
    angle: scripted.angle ?? `Something specific for ${business.name}.`,
    objective: 'conversion',
    skip,
    too_big: mode === 'scripted' ? (scripted.tooBig ?? false) : false,
  };
}

/**
 * Mirror of `assessProspect` in the engine, using the same functions in the
 * same order. Kept in step by `tests/growth-scenarios.test.ts`, which asserts
 * the ordering assumptions this depends on.
 */
export async function assessOne(
  scenario: Scenario,
  business: BusinessFixture,
  mode: ModelMode,
  prompts: PromptRecord[] = [],
): Promise<Assessment> {
  const website = business.osm?.website ?? '';
  const crawl = crawlOf(business, website || 'https://example.test/');

  const audit = auditSite(
    {
      name: business.name,
      website: website || undefined,
      mapsUrl: business.osm?.mapsUrl,
      reviewCount: business.osm?.reviewCount,
      email: business.osm?.email,
      phone: business.osm?.phone,
      openingHours: business.osm?.openingHours,
    },
    crawl,
    new Date('2026-09-13T00:00:00Z'),
  );

  const scale = assessScale(
    {
      name: business.name,
      brand: business.osm?.brand,
      brandWikidata: business.osm?.brandWikidata,
      operator: business.osm?.operator,
      branchCount: business.osm?.branchCount,
      reviewCount: business.osm?.reviewCount,
    },
    crawl,
  );

  // The engine only looks a business up when the measurements have not
  // already settled it, and treats a catalogued entity as decisive.
  const prominence: ProminenceResult = { ...EMPTY_PROMINENCE, checked: [], notes: [], mentions: [] };
  if (!scale.decisive && business.wikidata) {
    prominence.checked.push('wikidata');
    prominence.wikidataId = business.wikidata.id;
    prominence.wikidataDescription = business.wikidata.description;
    scale.score = Math.min(100, scale.score + 45);
    scale.decisive = true;
    scale.summary = `${business.name} has a Wikidata entry (${business.wikidata.description}). Too well known for a cold concept site.`;
  }

  const overCeiling = scale.score > scenario.scaleCeiling;
  const unreachable = !audit.contactable;
  const cannotQualify = combineScores(audit.presenceScore, 100) < scenario.scoreFloor;
  const settledByMeasurement = overCeiling || unreachable || cannotQualify;

  const ai = fakeAi(() => scriptedReply(business, mode), prompts);

  const qualification = settledByMeasurement
    ? null
    : await qualifyProspect(ai, {
        businessName: business.name,
        niche: scenario.niche,
        idealClient: scenario.idealClient,
        region: scenario.region,
        audit,
        scale,
        prominence,
        siteSummary: crawl?.pages[0]?.extracted.text.slice(0, 3000) ?? '',
        context: business.osm?.context ?? '',
        usage: { db: NO_DB, userId: 'bench', operation: 'qualify', stage: 'shortlist' },
      });

  const fitScore = qualification?.ok ? qualification.data.fitScore : 0;
  const skip =
    settledByMeasurement || scale.decisive || (qualification?.ok === true && qualification.data.skip);
  const score = skip ? 0 : combineScores(audit.presenceScore, fitScore);

  const eligible = !skip && score >= scenario.scoreFloor && scale.score <= scenario.scaleCeiling;
  const ruledOutBy: Assessment['ruledOutBy'] = overCeiling
    ? 'scale-ceiling'
    : unreachable
      ? 'unreachable'
      : cannotQualify
        ? 'no-honest-angle'
        : scale.decisive
          ? 'decisive-scale'
          : skip
            ? 'model-skip'
            : eligible
              ? null
              : 'score-floor';

  const scripted = scriptedReply(business, mode);

  return {
    name: business.name,
    want: business.want,
    why: business.why,
    audit,
    scale,
    modelCalled: !settledByMeasurement,
    modelFit: scripted ? Number(scripted.fit_score) : 0,
    qualification: qualification?.ok ? qualification.data : null,
    fitScore,
    presenceScore: audit.presenceScore,
    scaleScore: scale.score,
    score,
    skip,
    ruledOutBy,
    eligible,
    selected: false,
    contactable: audit.contactable,
  };
}

/* ------------------------------------------------------------------ */
/* A whole search                                                      */
/* ------------------------------------------------------------------ */

export interface ScenarioRun {
  scenario: Scenario;
  assessments: Assessment[];
  /** Picked, in the order the shortlist would take them. */
  selected: Assessment[];
  /** Model calls the run paid for. */
  modelCalls: number;
  prompts: PromptRecord[];
  /** Wanted as a lead and got through. */
  truePositives: Assessment[];
  /** Wanted rejected and got through anyway. The expensive mistake. */
  falsePositives: Assessment[];
  /** Wanted as a lead and did not get through. The invisible mistake. */
  falseNegatives: Assessment[];
}

/**
 * Run one search end to end under the `auto`/`manual` shortlist rule: rank by
 * score, take the top `targetCount` above the floor. `ai` mode hands the same
 * eligible set to a model, so this is the selection every mode starts from.
 */
export async function runScenario(scenario: Scenario, mode: ModelMode = 'scripted'): Promise<ScenarioRun> {
  const prompts: PromptRecord[] = [];
  const assessments: Assessment[] = [];

  for (const business of scenario.businesses) {
    assessments.push(await assessOne(scenario, business, mode, prompts));
  }

  const ranked = [...assessments].sort((a, b) => b.score - a.score);
  const selected = ranked.filter((a) => a.eligible).slice(0, scenario.targetCount);
  for (const pick of selected) pick.selected = true;

  return {
    scenario,
    assessments,
    selected,
    modelCalls: assessments.filter((a) => a.modelCalled).length,
    prompts,
    truePositives: selected.filter((a) => a.want === 'lead'),
    falsePositives: selected.filter((a) => a.want === 'reject'),
    falseNegatives: assessments.filter((a) => a.want === 'lead' && !a.selected),
  };
}

/** A readable table of what a run decided and why. */
export function formatRun(run: ScenarioRun): string {
  const rows = [...run.assessments].sort((a, b) => b.score - a.score);
  const width = Math.max(...rows.map((r) => r.name.length), 8);

  const lines = [
    `${run.scenario.niche} in ${run.scenario.region} ` +
      `(floor ${run.scenario.scoreFloor}, ceiling ${run.scenario.scaleCeiling}, want ${run.scenario.targetCount})`,
    '',
    `${'business'.padEnd(width)}  need  fit  scale  score  want    got     verdict`,
    `${'-'.repeat(width)}  ----  ---  -----  -----  ------  ------  -------`,
  ];

  for (const row of rows) {
    const got = row.selected ? 'lead' : 'reject';
    const mark = got === row.want ? ' ' : '!';
    lines.push(
      [
        row.name.padEnd(width),
        String(row.presenceScore).padStart(4),
        String(row.fitScore).padStart(4),
        String(row.scaleScore).padStart(6),
        String(row.score).padStart(6),
        ` ${row.want.padEnd(6)}`,
        `${mark}${got.padEnd(6)}`,
        row.ruledOutBy ?? (row.selected ? 'selected' : 'below the cut'),
      ].join('  '),
    );
  }

  lines.push(
    '',
    `selected ${run.selected.length}/${run.scenario.targetCount} · ` +
      `right ${run.truePositives.length} · wrong ${run.falsePositives.length} · ` +
      `missed ${run.falseNegatives.length} · model calls ${run.modelCalls}/${run.assessments.length}`,
  );

  return lines.join('\n');
}
