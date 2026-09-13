import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { settings } from '~/lib/db/schema';
import { getSettings } from '~/lib/queries/settings';
import { policyFromForm, serialisePolicy } from '~/lib/growth/policy';
import { toProviderName } from '~/lib/growth/discovery/index';

export const prerender = false;

/** Hostname-ish, so a typo does not produce demo hosts nobody can reach. */
function cleanHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : '';
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const current = await getSettings(database, user.id);
  const text = (key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

  const cap = Number.parseInt(String(form.get('outreachDailyCap') ?? ''), 10);
  const cacheHours = Number.parseInt(String(form.get('aiCacheTtlHours') ?? ''), 10);
  const host = cleanHost(text('demoHost', 200));
  const provider =
    toProviderName(form.get('growthDiscoveryProvider')) ?? current.growthDiscoveryProvider;

  await database
    .update(settings)
    .set({
      growthPolicy: serialisePolicy(policyFromForm(form)),
      growthBrandKitId: text('growthBrandKitId', 40) || null,
      growthDiscoveryProvider: provider,
      demoHost: host || current.demoHost,
      // Clamped rather than validated away: a cap someone typed as 1000 is a
      // mistake worth catching, and a negative one would disable the check.
      outreachDailyCap: Number.isFinite(cap) ? Math.min(Math.max(cap, 0), 100) : current.outreachDailyCap,
      outreachSenderName: text('outreachSenderName', 120),
      outreachBio: text('outreachBio', 2000),
      outreachSignature: text('outreachSignature', 1000),
      outreachReplyTo: text('outreachReplyTo', 320),
      aiCacheTtlHours: Number.isFinite(cacheHours)
        ? Math.min(Math.max(cacheHours, 0), 720)
        : current.aiCacheTtlHours,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(settings.id, current.id));

  const warning = host || !text('demoHost', 200) ? '' : '&error=That+demo+host+did+not+look+like+a+hostname%2C+so+it+was+left+as+it+was.';
  return redirect(`/growth/settings?saved=1${warning}`, 302);
};
