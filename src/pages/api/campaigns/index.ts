import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { bindings, db } from '~/lib/env';
import { brandKits, campaigns } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { policyFromForm, serialisePolicy } from '~/lib/growth/policy';
import { startCampaign } from '~/lib/growth/agent-client';
import { getProvider, toProviderName } from '~/lib/growth/discovery/index';

export const prerender = false;

/** Bounded integer from a form field. */
function int(value: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const text = (key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

  const niche = text('niche', 120);
  const region = text('region', 120);
  const provider = toProviderName(form.get('discoveryProvider')) ?? 'overpass';
  const manualInput = text('manualInput', 20_000);

  if (!niche && provider !== 'manual') {
    return redirect('/growth/new?error=Name+the+trade+you+are+looking+for.', 302);
  }
  if (!region && provider !== 'manual') {
    return redirect('/growth/new?error=Name+a+region+to+search+inside.', 302);
  }
  if (provider === 'manual' && !manualInput) {
    return redirect('/growth/new?error=Paste+at+least+one+business.', 302);
  }

  const database = db();
  const brandKitId = text('brandKitId', 40) || null;

  // Never accept a brand kit id belonging to somebody else.
  if (brandKitId) {
    const rows = await database
      .select({ id: brandKits.id })
      .from(brandKits)
      .where(eq(brandKits.id, brandKitId))
      .limit(1);
    if (!rows[0]) {
      return redirect('/growth/new?error=That+style+direction+no+longer+exists.', 302);
    }
  }

  const overrides: Record<string, string> = {};
  for (const field of ['direction', 'tone', 'avoid', 'capabilities'] as const) {
    const value = text(`brief.${field}`, 4000);
    if (value) overrides[field] = value;
  }

  const references = text('brief.references', 4000)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const [url, ...note] = line.split(/\s+[—–-]\s+/);
      return { url: url!.trim().slice(0, 500), note: note.join(' ').slice(0, 300) };
    });
  const briefOverrides = references.length
    ? JSON.stringify({ ...overrides, references })
    : JSON.stringify(overrides);

  const now = new Date().toISOString();
  const id = newId();

  await database.insert(campaigns).values({
    id,
    userId: user.id,
    name: text('name', 160) || `${niche || 'Pasted list'} in ${region || 'no region'}`,
    niche,
    idealClient: text('idealClient', 2000),
    region,
    country: form.get('country') === 'AU' ? 'AU' : 'NZ',
    discoveryProvider: provider,
    manualInput,
    brandKitId,
    briefOverrides,
    policy: serialisePolicy(policyFromForm(form)),
    stage: 'brief',
    status: 'draft',
    targetCount: int(form.get('targetCount'), 10, 1, 50),
    scoreFloor: int(form.get('scoreFloor'), 55, 0, 100),
    createdAt: now,
    updatedAt: now,
  });

  // Fail early and legibly rather than starting a run that cannot discover.
  const unavailable = getProvider(provider).unavailableReason({
    niche,
    region,
    country: form.get('country') === 'AU' ? 'AU' : 'NZ',
    limit: 10,
    manualInput,
    apiKey: bindings().GOOGLE_PLACES_API_KEY,
    userAgent: 'check',
  });
  if (unavailable) {
    return redirect(`/growth/${id}?error=${encodeURIComponent(unavailable)}`, 302);
  }

  if (form.get('start') === 'yes') {
    await database
      .update(campaigns)
      .set({ status: 'running', startedAt: now })
      .where(eq(campaigns.id, id));
    try {
      await startCampaign(bindings(), id, user.id);
    } catch (error) {
      return redirect(
        `/growth/${id}?error=${encodeURIComponent(`The run was created but the agent could not be reached: ${error}`)}`,
        302,
      );
    }
  }

  return redirect(`/growth/${id}`, 302);
};
