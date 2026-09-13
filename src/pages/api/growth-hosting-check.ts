import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { demoSites, settings } from '~/lib/db/schema';
import { getSettings } from '~/lib/queries/settings';
import { checkDemoHosting, demoPublicUrl } from '~/lib/growth/publish';
import { appUrl } from '~/lib/env';

export const prerender = false;

/**
 * Does the demo wildcard actually serve?
 *
 * Until this passes, demos are linked on the app's own origin. The check has
 * to run against a demo that exists, because an empty host and a missing
 * route both look like a 404 from outside — so it picks the most recent live
 * demo and fetches it.
 */
export const POST: APIRoute = async ({ locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const database = db();
  const current = await getSettings(database, user.id);
  const now = new Date().toISOString();

  const live = await database
    .select()
    .from(demoSites)
    .where(eq(demoSites.status, 'live'))
    .orderBy(desc(demoSites.createdAt))
    .limit(1);

  const demo = live.find((row) => row.userId === user.id);

  if (!demo) {
    const detail =
      'There is no live demo to test against yet. Build one first — the check needs a real page ' +
      'to fetch, because a missing route and an empty host look identical from outside.';
    await database
      .update(settings)
      .set({ demoHostCheckedAt: now, demoHostCheckResult: detail, updatedAt: now })
      .where(eq(settings.id, current.id));
    return redirect(`/growth/settings?error=${encodeURIComponent(detail)}`, 302);
  }

  const result = await checkDemoHosting(demo.host);

  await database
    .update(settings)
    .set({
      demoHostVerified: result.ok,
      demoHostCheckedAt: now,
      demoHostCheckResult: result.detail.slice(0, 500),
      updatedAt: now,
    })
    .where(eq(settings.id, current.id));

  /**
   * Re-point existing demos at whichever address now works. A run from before
   * the DNS was set up should not keep advertising a path URL forever, and a
   * zone that has stopped resolving should fall back rather than keep handing
   * out dead links.
   */
  const all = await database.select().from(demoSites).where(eq(demoSites.userId, user.id));
  for (const row of all) {
    const next = demoPublicUrl(appUrl(), row.host, result.ok);
    if (next !== row.publicUrl) {
      await database
        .update(demoSites)
        .set({ publicUrl: next, updatedAt: now })
        .where(eq(demoSites.id, row.id));
    }
  }

  return redirect(`/growth/settings?saved=1&checked=${result.ok ? 'ok' : 'failed'}`, 302);
};
