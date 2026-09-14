/**
 * Gathering what runs actually did, for the recommender.
 *
 * One place that knows the queries, so `recommend.ts` stays a pure function of
 * the numbers and can be tested without a database.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import {
  aiCalls,
  campaignEvents,
  campaigns,
  demoSites,
  growthDismissals,
  proposals,
  prospectArtifacts,
  prospects,
  type Settings,
} from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { applyDismissals, recommend, type Recommendation, type RunSignals } from '~/lib/growth/recommend';

/** How far back a recommendation looks. Long enough to cover a few runs. */
export const WINDOW_DAYS = 30;

export async function gatherSignals(
  db: Db,
  userId: string,
  settings: Settings,
  placesKeySet: boolean,
  windowDays = WINDOW_DAYS,
): Promise<RunSignals> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const [runRows, callRows, warningRows, built, selected, drafted, withImages] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(campaigns)
      .where(and(eq(campaigns.userId, userId), gte(campaigns.createdAt, since))),

    db
      .select({
        operation: aiCalls.operation,
        total: sql<number>`count(*)`,
        failed: sql<number>`coalesce(sum(case when ${aiCalls.ok} then 0 else 1 end), 0)`,
      })
      .from(aiCalls)
      .where(and(eq(aiCalls.userId, userId), gte(aiCalls.createdAt, since)))
      .groupBy(aiCalls.operation),

    db
      .select({ stage: campaignEvents.stage, count: sql<number>`count(*)` })
      .from(campaignEvents)
      .where(
        and(
          eq(campaignEvents.userId, userId),
          gte(campaignEvents.createdAt, since),
          inArray(campaignEvents.level, ['warn', 'error']),
        ),
      )
      .groupBy(campaignEvents.stage),

    db
      .select({ id: demoSites.id, prospectId: demoSites.prospectId })
      .from(demoSites)
      .where(and(eq(demoSites.userId, userId), gte(demoSites.createdAt, since))),

    db
      .select({
        total: sql<number>`count(*)`,
        withEmail: sql<number>`coalesce(sum(case when ${prospects.email} <> '' then 1 else 0 end), 0)`,
        withoutWebsite: sql<number>`coalesce(sum(case when ${prospects.website} = '' then 1 else 0 end), 0)`,
      })
      .from(prospects)
      .where(
        and(
          eq(prospects.userId, userId),
          eq(prospects.selected, true),
          gte(prospects.createdAt, since),
        ),
      ),

    db
      .select({ n: sql<number>`count(*)` })
      .from(proposals)
      .where(
        and(
          eq(proposals.userId, userId),
          eq(proposals.status, 'draft'),
          gte(proposals.createdAt, since),
        ),
      ),

    /**
     * Which prospects hold a picture. Counted from the artifacts rather than
     * from the demo, because a demo row does not record how many frames it
     * ended up filling — and the artifact is the thing that would have filled
     * them.
     */
    db
      .selectDistinct({ prospectId: prospectArtifacts.prospectId })
      .from(prospectArtifacts)
      .where(and(eq(prospectArtifacts.userId, userId), eq(prospectArtifacts.kind, 'image'))),
  ]);

  const haveImages = new Set(withImages.map((row) => row.prospectId));
  const builtProspects = new Set(built.map((row) => row.prospectId));
  let builtWithoutImages = 0;
  for (const prospectId of builtProspects) {
    if (!haveImages.has(prospectId)) builtWithoutImages++;
  }

  const selection = selected[0] ?? { total: 0, withEmail: 0, withoutWebsite: 0 };

  return {
    runs: runRows[0]?.n ?? 0,
    calls: callRows.map((row) => ({
      operation: row.operation || 'unknown',
      total: row.total,
      failed: row.failed,
    })),
    warnings: warningRows.map((row) => ({ stage: row.stage || 'unknown', count: row.count })),
    builtCount: builtProspects.size,
    builtWithoutImages,
    selectedCount: selection.total,
    selectedWithEmail: selection.withEmail,
    selectedWithoutWebsite: selection.withoutWebsite,
    settings: {
      generateDemoImages: settings.generateDemoImages,
      maxGeneratedImages: settings.maxGeneratedImages,
      discoveryProvider: settings.growthDiscoveryProvider,
      placesKeySet,
      outreachDailyCap: settings.outreachDailyCap,
      aiCacheTtlHours: settings.aiCacheTtlHours,
      demoHostVerified: settings.demoHostVerified,
    },
    draftedProposals: drafted[0]?.n ?? 0,
  };
}

/** What to show, with anything already waved away at these numbers removed. */
export async function liveRecommendations(
  db: Db,
  userId: string,
  settings: Settings,
  placesKeySet: boolean,
): Promise<Recommendation[]> {
  try {
    const signals = await gatherSignals(db, userId, settings, placesKeySet);
    const dismissals = await db
      .select({
        recommendationId: growthDismissals.recommendationId,
        signature: growthDismissals.signature,
      })
      .from(growthDismissals)
      .where(eq(growthDismissals.userId, userId));

    return applyDismissals(recommend(signals), dismissals);
  } catch {
    // A page that cannot compute its suggestions shows none, rather than 500.
    return [];
  }
}

export async function dismissRecommendation(
  db: Db,
  userId: string,
  recommendationId: string,
  signature: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ id: growthDismissals.id })
    .from(growthDismissals)
    .where(
      and(
        eq(growthDismissals.userId, userId),
        eq(growthDismissals.recommendationId, recommendationId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(growthDismissals)
      .set({ signature, createdAt: now })
      .where(eq(growthDismissals.id, existing[0].id));
    return;
  }

  await db.insert(growthDismissals).values({
    id: newId(),
    userId,
    recommendationId: recommendationId.slice(0, 200),
    signature: signature.slice(0, 200),
    createdAt: now,
  });
}
