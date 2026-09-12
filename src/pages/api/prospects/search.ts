import type { APIRoute } from 'astro';
import { db, ai } from '~/lib/env';
import { prospectSearches, prospects } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { discoverProspects, scoreProspects } from '~/lib/ai/prospecting';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const niche = String(form.get('niche') ?? '').trim().slice(0, 100);
  const region = String(form.get('region') ?? '').trim().slice(0, 100);
  const country = form.get('country') === 'AU' ? 'AU' : 'NZ';

  if (!niche || !region) return redirect('/clients/prospect?error=Enter a niche and a region.', 302);

  const database = db();
  const searchId = newId();
  const now = new Date().toISOString();

  await database.insert(prospectSearches).values({
    id: searchId,
    userId: user.id,
    niche,
    region,
    country,
    styleRepertoireId: String(form.get('styleRepertoireId') ?? '') || null,
    status: 'running',
    startedAt: now,
    createdAt: now,
  });

  const discovered = await discoverProspects({ niche, region, country });

  if (!discovered.ok) {
    await database.insert(prospectSearches).values({
      id: newId(),
      userId: user.id,
      niche,
      region,
      country,
      status: 'failed',
      error: discovered.error,
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return redirect(`/clients/prospect?error=${encodeURIComponent(discovered.error)}`, 302);
  }

  const scored = await scoreProspects(ai(), discovered.data, niche);
  if (!scored.ok) {
    return redirect(`/clients/prospect?error=${encodeURIComponent(scored.error)}`, 302);
  }

  for (const prospect of scored.data) {
    await database.insert(prospects).values({
      id: newId(),
      userId: user.id,
      searchId,
      businessName: prospect.businessName,
      niche,
      region,
      country,
      website: prospect.website ?? '',
      email: prospect.email ?? '',
      phone: prospect.phone ?? '',
      address: prospect.address ?? '',
      mapsUrl: prospect.mapsUrl ?? '',
      socialLinks: '[]',
      signal: prospect.signal,
      score: prospect.score,
      findings: JSON.stringify({ reasoning: prospect.reasoning, angle: prospect.angle }),
      status: 'new',
      notes: prospect.angle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return redirect('/clients/prospect', 302);
};
