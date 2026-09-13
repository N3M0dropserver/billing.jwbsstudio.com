/**
 * How much of a run happens without you.
 *
 * Every stage carries one of three modes. The distinction that matters is
 * between `ai` and `auto`: `auto` is not the more autonomous of the two, it
 * is the less considered one. On the shortlist stage `auto` takes everything
 * above the score floor without asking a model anything; `ai` has the model
 * pick, and records why. `manual` does the stage's work and then stops.
 *
 * Resolution order, most specific first:
 *   1. the campaign's own policy
 *   2. the user's saved defaults
 *   3. SAFE_DEFAULTS below
 *
 * SAFE_DEFAULTS deliberately leaves the two stages with consequences outside
 * this app — publishing a site to a public subdomain, and emailing a
 * stranger — on `manual`. Opting out of that is a decision someone should
 * have to make on purpose.
 */

/**
 * Imports across this directory are relative rather than using the `~` alias
 * the rest of the app uses. The growth library is compiled into two Workers —
 * this app, and the agent in `workers/agent`, which is bundled by wrangler
 * and does not resolve the alias. Relative paths work in both.
 */

import { CAMPAIGN_STAGES, STAGE_MODES, type CampaignStage, type StageMode } from '../db/schema';

export { CAMPAIGN_STAGES, STAGE_MODES };
export type { CampaignStage, StageMode };

export type StagePolicy = Record<CampaignStage, StageMode>;

export const SAFE_DEFAULTS: StagePolicy = {
  brief: 'auto',
  discover: 'auto',
  shortlist: 'manual',
  enrich: 'auto',
  plan: 'ai',
  build: 'manual',
  propose: 'manual',
};

/** Everything on, for when you trust it. Still bounded by the outreach cap. */
export const FULL_AUTO: StagePolicy = {
  brief: 'auto',
  discover: 'auto',
  shortlist: 'ai',
  enrich: 'auto',
  plan: 'ai',
  build: 'auto',
  propose: 'ai',
};

/** Nothing moves without you. */
export const FULL_MANUAL: StagePolicy = Object.fromEntries(
  CAMPAIGN_STAGES.map((stage) => [stage, 'manual' as StageMode]),
) as StagePolicy;

export const STAGE_LABELS: Record<CampaignStage, string> = {
  brief: 'Brief',
  discover: 'Discover',
  shortlist: 'Shortlist',
  enrich: 'Research',
  plan: 'Design plan',
  build: 'Build demo',
  propose: 'Proposal',
};

export const STAGE_DESCRIPTIONS: Record<CampaignStage, string> = {
  brief: 'Resolve the style direction, references and rules this run builds against.',
  discover: 'Find businesses matching the niche and region.',
  shortlist: 'Rank them on the state of their web presence and pick who to pursue.',
  enrich: 'Crawl their site, find contacts, socials, reviews and imagery.',
  plan: 'Write the design and page spec for each one.',
  build: 'Generate the demo site and publish it to a subdomain.',
  propose: 'Draft the outreach email and send it.',
};

/** What each mode means on a given stage, in the user's terms. */
export const MODE_LABELS: Record<StageMode, string> = {
  manual: 'Ask me',
  ai: 'AI decides',
  auto: 'Just do it',
};

export function isStage(value: unknown): value is CampaignStage {
  return typeof value === 'string' && (CAMPAIGN_STAGES as readonly string[]).includes(value);
}

export function isMode(value: unknown): value is StageMode {
  return typeof value === 'string' && (STAGE_MODES as readonly string[]).includes(value);
}

/** Parse a stored policy blob, keeping only stages and modes we recognise. */
export function parsePolicy(raw: string | null | undefined): Partial<StagePolicy> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Partial<StagePolicy> = {};
  for (const [stage, mode] of Object.entries(parsed as Record<string, unknown>)) {
    if (isStage(stage) && isMode(mode)) out[stage] = mode;
  }
  return out;
}

/**
 * Merge campaign policy over user defaults over the safe baseline.
 */
export function resolvePolicy(
  campaignPolicy: string | null | undefined,
  userDefaults: string | null | undefined,
): StagePolicy {
  return { ...SAFE_DEFAULTS, ...parsePolicy(userDefaults), ...parsePolicy(campaignPolicy) };
}

export function serialisePolicy(policy: Partial<StagePolicy>): string {
  const clean: Partial<StagePolicy> = {};
  for (const stage of CAMPAIGN_STAGES) {
    const mode = policy[stage];
    if (isMode(mode)) clean[stage] = mode;
  }
  return JSON.stringify(clean);
}

/** Read a policy out of submitted form data, ignoring anything unrecognised. */
export function policyFromForm(form: {
  get(key: string): FormDataEntryValue | null;
}): Partial<StagePolicy> {
  const policy: Partial<StagePolicy> = {};
  for (const stage of CAMPAIGN_STAGES) {
    const value = form.get(`policy.${stage}`);
    if (isMode(value)) policy[stage] = value;
  }
  return policy;
}

export function nextStage(stage: CampaignStage): CampaignStage | null {
  const index = CAMPAIGN_STAGES.indexOf(stage);
  return index >= 0 && index < CAMPAIGN_STAGES.length - 1
    ? CAMPAIGN_STAGES[index + 1]!
    : null;
}

export function stageIndex(stage: CampaignStage): number {
  return CAMPAIGN_STAGES.indexOf(stage);
}

/** True when `a` has reached at least `b`. */
export function stageAtLeast(a: CampaignStage, b: CampaignStage): boolean {
  return stageIndex(a) >= stageIndex(b);
}
