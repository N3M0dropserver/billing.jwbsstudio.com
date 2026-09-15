import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/env';
import { BROWSER_MODES, SELF_IMPROVE_MODES, settings } from '~/lib/db/schema';
import { getSettings } from '~/lib/queries/settings';
import { policyFromForm, serialisePolicy } from '~/lib/growth/policy';
import { toProviderName } from '~/lib/growth/discovery/index';
import { cleanDemoHost } from '~/lib/growth/publish';

export const prerender = false;

/** Hostname-ish, so a typo does not produce demo hosts nobody can reach. */
/** Narrow a submitted value to one of a fixed set, or fall back. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const current = await getSettings(database, user.id);
  const text = (key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

  const cap = Number.parseInt(String(form.get('outreachDailyCap') ?? ''), 10);
  const stepBudget = Number.parseInt(String(form.get('agentStepBudget') ?? ''), 10);
  const researchCap = Number.parseInt(String(form.get('agentResearchDailyCap') ?? ''), 10);
  const cacheHours = Number.parseInt(String(form.get('aiCacheTtlHours') ?? ''), 10);
  const maxImages = Number.parseInt(String(form.get('maxGeneratedImages') ?? ''), 10);
  const host = cleanDemoHost(text('demoHost', 200));
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
      generateDemoImages: form.get('generateDemoImages') === 'yes',
      // Six is the most the renderer can place; anything above it would be
      // paid for and never shown.
      maxGeneratedImages: Number.isFinite(maxImages)
        ? Math.min(Math.max(maxImages, 0), 6)
        : current.maxGeneratedImages,

      agentBrowserMode: oneOf(form.get('agentBrowserMode'), BROWSER_MODES, current.agentBrowserMode),
      agentStepBudget: Number.isFinite(stepBudget)
        ? Math.min(Math.max(stepBudget, 1), 24)
        : current.agentStepBudget,
      // An unticked checkbox is not submitted at all, so absence is "off"
      // rather than "unchanged" — which is only correct because both boxes
      // are always rendered on the form that posts here.
      agentMemoryEnabled: form.get('agentMemoryEnabled') === 'on',
      agentSkillsEnabled: form.get('agentSkillsEnabled') === 'on',
      agentSelfImprove: oneOf(form.get('agentSelfImprove'), SELF_IMPROVE_MODES, current.agentSelfImprove),
      agentResearchDailyCap: Number.isFinite(researchCap)
        ? Math.min(Math.max(researchCap, 0), 200)
        : current.agentResearchDailyCap,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(settings.id, current.id));

  const warning = host || !text('demoHost', 200) ? '' : '&error=That+demo+host+did+not+look+like+a+hostname%2C+so+it+was+left+as+it+was.';
  return redirect(`/growth/settings?saved=1${warning}`, 302);
};
