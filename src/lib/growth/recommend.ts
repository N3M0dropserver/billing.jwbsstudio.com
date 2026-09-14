/**
 * What the last runs actually did, turned into things to change.
 *
 * Every signal here is measured from rows the pipeline already writes — failed
 * model calls, warnings a stage logged, demos that shipped with no pictures,
 * prospects with nowhere to send an email. None of it is a model's opinion of
 * the work, because a model's opinion of the work is exactly the thing that
 * was already wrong when a run produced ten pages nobody would send.
 *
 * The rule each recommendation has to pass: it names a number from a real run,
 * and it names one thing to do about it, in one place. A suggestion that says
 * "consider improving your prompts" is noise dressed as help.
 *
 * Recommendations are computed on demand rather than stored — the run data is
 * the truth and a cached copy of it would go stale. The only thing persisted
 * is a dismissal, and that carries a signature so a problem that gets worse
 * comes back rather than staying hidden.
 */

export type Severity = 'blocking' | 'quality' | 'opportunity';

export interface Recommendation {
  /** Stable for the same problem, so a dismissal sticks to it. */
  id: string;
  severity: Severity;
  title: string;
  /** What was measured. The evidence, in a sentence. */
  detail: string;
  /** The one thing to do. */
  action: string;
  /** Where to do it. */
  href: string;
  linkLabel: string;
  /**
   * What the numbers looked like. A dismissal records this, and the
   * recommendation returns when it changes for the worse.
   */
  signature: string;
}

/**
 * Everything the recommender reads.
 *
 * Passed in rather than queried here so this file stays a pure function of
 * the numbers — which is what makes it testable without a database.
 */
export interface RunSignals {
  /** Runs in the window. Nothing is recommended from an empty history. */
  runs: number;
  /** Model calls, and how many failed, by operation. */
  calls: Array<{ operation: string; total: number; failed: number }>;
  /** Warnings a stage logged, by stage. */
  warnings: Array<{ stage: string; count: number }>;
  /** Prospects that reached the build stage. */
  builtCount: number;
  /** Of those, how many shipped with no photograph at all. */
  builtWithoutImages: number;
  /** Prospects selected for pursuit, and how many have an email address. */
  selectedCount: number;
  selectedWithEmail: number;
  /** Of those pursued, how many had no website of their own. */
  selectedWithoutWebsite: number;
  /** Current settings that bear on the above. */
  settings: {
    generateDemoImages: boolean;
    maxGeneratedImages: number;
    discoveryProvider: string;
    placesKeySet: boolean;
    outreachDailyCap: number;
    aiCacheTtlHours: number;
    demoHostVerified: boolean;
  };
  /** Proposals drafted and waiting to be sent by hand. */
  draftedProposals: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { blocking: 0, quality: 1, opportunity: 2 };

/**
 * Work out what to suggest.
 *
 * Ordered by severity and then by how much of the run it affected, because a
 * list of fifteen equal-looking suggestions is a list nobody acts on.
 */
export function recommend(signals: RunSignals): Recommendation[] {
  const out: Recommendation[] = [];
  const s = signals.settings;

  /* -- Things that are simply broken ------------------------------- */

  for (const call of signals.calls) {
    if (call.total < 3 || call.failed === 0) continue;
    const rate = call.failed / call.total;
    if (rate < 0.25) continue;

    out.push({
      id: `model-calls-failing:${call.operation}`,
      severity: 'blocking',
      title: `Every ${call.operation} call is failing`,
      detail:
        `${call.failed} of ${call.total} ${call.operation} calls returned an error. ` +
        (call.operation === 'qualify'
          ? 'A failed judgement scores fit 0, so the shortlist ranks on need alone — which ' +
            'picks the businesses with the least to build a page from.'
          : 'Whatever that stage produces is falling back to something written without a model.'),
      action: 'Open the AI page and read the error on a recent call — it names the cause.',
      href: '/growth/ai',
      linkLabel: 'See the failures',
      signature: `${call.failed}/${call.total}`,
    });
  }

  const planWarnings = signals.warnings.find((warning) => warning.stage === 'plan')?.count ?? 0;
  if (planWarnings > 0 && signals.builtCount > 0) {
    const share = planWarnings / Math.max(signals.builtCount, 1);
    if (share >= 0.2) {
      out.push({
        id: 'plans-scaffolded',
        severity: 'blocking',
        title: 'Demos are being built from scaffolds, not plans',
        detail:
          `${planWarnings} plan${planWarnings === 1 ? '' : 's'} fell back to a scaffold. ` +
          'A scaffold is laid out from facts alone — no written copy, no argument, no voice.',
        action:
          'Check the run log for the reason given on each. If it is the model, the design ' +
          'instructions are where to change what it is asked for.',
        href: '/growth/prompts',
        linkLabel: 'Design instructions',
        signature: String(planWarnings),
      });
    }
  }

  /* -- Things that make the output worse --------------------------- */

  if (signals.builtCount > 0 && signals.builtWithoutImages / signals.builtCount >= 0.5) {
    const detail =
      `${signals.builtWithoutImages} of ${signals.builtCount} demos went out with no ` +
      'photography at all. A page with no pictures is the single thing that makes a concept ' +
      'read as a template with a name dropped in.';

    if (!s.generateDemoImages && s.discoveryProvider !== 'google-places') {
      out.push({
        id: 'no-photography:nowhere-to-get-it',
        severity: 'quality',
        title: 'Demos have no photography, and nowhere to get any',
        detail:
          `${detail} Generation is off, and ${s.discoveryProvider} carries no pictures of a ` +
          'business, so there is no source at all.',
        action:
          'Switch the source to Google Places with a key set — that brings their own listing ' +
          'photographs — or turn placeholder generation on.',
        href: '/growth/settings',
        linkLabel: 'Growth defaults',
        signature: `${signals.builtWithoutImages}/${signals.builtCount}:none`,
      });
    } else if (s.discoveryProvider !== 'google-places') {
      out.push({
        id: 'no-photography:no-real-source',
        severity: 'quality',
        title: 'Every picture on a demo is generated',
        detail:
          `${detail} Generation is on, but ${s.discoveryProvider} carries none of their own ` +
          'photographs, so nothing real reaches a page for a business with no website.',
        action:
          'Switch the source to Google Places and set GOOGLE_PLACES_API_KEY — their listing ' +
          'photographs beat anything generated.',
        href: '/growth/settings',
        linkLabel: 'Growth defaults',
        signature: `${signals.builtWithoutImages}/${signals.builtCount}:generated-only`,
      });
    } else if (!s.generateDemoImages) {
      out.push({
        id: 'no-photography:generation-off',
        severity: 'quality',
        title: 'Demos have no photography',
        detail: `${detail} Their listings had none to use and generation is switched off.`,
        action: 'Turn placeholder generation on, so the frames that stay empty get filled.',
        href: '/growth/settings',
        linkLabel: 'Growth defaults',
        signature: `${signals.builtWithoutImages}/${signals.builtCount}:off`,
      });
    }
  }

  if (s.discoveryProvider === 'google-places' && !s.placesKeySet) {
    out.push({
      id: 'places-key-missing',
      severity: 'blocking',
      title: 'Google Places is selected but has no key',
      detail: 'Discovery will fail outright until GOOGLE_PLACES_API_KEY is set as a Worker secret.',
      action: 'Set the secret, or switch the source back to OpenStreetMap.',
      href: '/growth/settings',
      linkLabel: 'Growth defaults',
      signature: 'missing',
    });
  }

  if (signals.selectedCount > 0) {
    const without = signals.selectedCount - signals.selectedWithEmail;
    if (without / signals.selectedCount >= 0.5) {
      out.push({
        id: 'no-email-to-write-to',
        severity: 'quality',
        title: 'Most of what you pursued has no email address',
        detail:
          `${without} of ${signals.selectedCount} pursued prospects have nowhere to send the ` +
          'demo. The page gets built and the email cannot be written.',
        action:
          signals.selectedWithoutWebsite >= signals.selectedCount / 2
            ? 'These are businesses with no website, so there is no page to find an address on. ' +
              'Raise the fit bar, or plan to reach them by phone.'
            : 'Their sites have no address on them. Worth checking the crawl reached more than ' +
              'the homepage.',
        href: '/growth',
        linkLabel: 'Review the runs',
        signature: `${without}/${signals.selectedCount}`,
      });
    }
  }

  /* -- Things that are merely being left on the table -------------- */

  if (s.outreachDailyCap === 0 && signals.draftedProposals > 0) {
    out.push({
      id: 'outreach-capped-to-zero',
      severity: 'opportunity',
      title: `${signals.draftedProposals} drafted email${signals.draftedProposals === 1 ? '' : 's'} waiting on you`,
      detail:
        'The unattended send cap is zero, so runs draft every email and stop. That is a ' +
        'deliberate setting and may well be the right one.',
      action: 'Send them by hand from each proposal, or raise the cap to let runs send.',
      href: '/growth',
      linkLabel: 'Review the runs',
      signature: String(signals.draftedProposals),
    });
  }

  if (!s.demoHostVerified && signals.builtCount > 0) {
    out.push({
      id: 'demo-host-unverified',
      severity: 'opportunity',
      title: 'Demos are linked on this app rather than their own subdomain',
      detail:
        'Hosting has not been verified, so every demo link points at billing.jwbsstudio.com. ' +
        'It works, and it looks less like a concept site built for them.',
      action: 'Add the DNS record and the Worker route, then run the hosting check.',
      href: '/growth/settings',
      linkLabel: 'Check hosting',
      signature: 'unverified',
    });
  }

  if (s.aiCacheTtlHours === 0 && signals.runs > 1) {
    out.push({
      id: 'ai-cache-off',
      severity: 'opportunity',
      title: 'Identical model requests are paid for twice',
      detail:
        'Request caching is off, so re-running a stage costs the same as running it the first ' +
        'time. Re-running a stage is most of what tuning a prompt involves.',
      action: 'Set a cache window — 72 hours is the default, and a changed prompt is a fresh call.',
      href: '/growth/settings',
      linkLabel: 'Growth defaults',
      signature: '0',
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Drop the ones dismissed at the same numbers. A worse number comes back. */
export function applyDismissals(
  recommendations: Recommendation[],
  dismissals: Array<{ recommendationId: string; signature: string }>,
): Recommendation[] {
  const seen = new Map(dismissals.map((row) => [row.recommendationId, row.signature]));

  return recommendations.filter((rec) => {
    if (!seen.has(rec.id)) return true;
    return seen.get(rec.id) !== rec.signature;
  });
}
