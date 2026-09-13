import type { APIRoute } from 'astro';
import { and, eq, ne } from 'drizzle-orm';
import { db, files } from '~/lib/env';
import { brandAssets, brandKits } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { brandAssetKey, putObject, safeSegment } from '~/lib/growth/storage';
import { DEFAULT_SECTION_ORDER, FALLBACK_BRIEF } from '~/lib/growth/brief';

export const prerender = false;

/** Anything a browser will render inline, and font files. Nothing else. */
const ALLOWED_UPLOADS = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml',
  'application/pdf', 'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  'application/zip',
]);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Parse the reference-site textarea.
 *
 * One per line, optionally `https://example.com — why this one`, which is how
 * a person writes a list rather than how a form wants one.
 */
export function parseReferences(raw: string): Array<{ url: string; note: string }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => {
      const [url, ...rest] = line.split(/\s+[—–|]\s+|\s+-\s+/);
      return { url: url!.trim().slice(0, 500), note: rest.join(' ').trim().slice(0, 300) };
    })
    .filter((reference) => /^https?:\/\/\S+$/i.test(reference.url));
}

/**
 * Parse the typography textarea.
 *
 * `role: Family` per line, with an optional Google Fonts URL. Anything a
 * browser cannot be told to load is dropped rather than half-applied.
 */
export function parseTypography(raw: string): typeof FALLBACK_BRIEF.typography {
  const roles = ['display', 'heading', 'body', 'mono', 'accent'] as const;

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => {
      const [left, ...rest] = line.split(':');
      const role = (roles as readonly string[]).includes(left!.trim().toLowerCase())
        ? (left!.trim().toLowerCase() as (typeof roles)[number])
        : 'body';
      const remainder = rest.join(':').trim() || left!.trim();
      const urlMatch = remainder.match(/https:\/\/fonts\.googleapis\.com\/\S+/);
      const family = remainder.replace(urlMatch?.[0] ?? '', '').replace(/[,;]\s*$/, '').trim();

      return {
        role,
        family: family.slice(0, 80),
        fallback:
          role === 'mono'
            ? 'ui-monospace, SFMono-Regular, monospace'
            : role === 'display' || role === 'heading'
              ? 'Georgia, "Times New Roman", serif'
              : 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        source: urlMatch ? ('google' as const) : ('system' as const),
        url: urlMatch?.[0] ?? '',
        weights: [400, 600],
      };
    })
    .filter((face) => face.family);
}

/** Parse the palette textarea: `name #hex role` per line. */
export function parsePalette(raw: string): typeof FALLBACK_BRIEF.palette {
  const roles = ['background', 'surface', 'text', 'muted', 'accent', 'border', 'other'] as const;

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((line) => {
      const parts = line.split(/[\s,]+/).filter(Boolean);
      const value = parts.find((part) => /^(#|rgb|hsl|oklch)/i.test(part)) ?? '';
      const name = (parts[0] === value ? 'colour' : parts[0]!) .toLowerCase().replace(/[^a-z0-9-]/g, '');
      const role = parts.find((part) => (roles as readonly string[]).includes(part.toLowerCase()));

      return {
        name: name.slice(0, 40) || 'colour',
        value: value.slice(0, 60),
        role: (role?.toLowerCase() ?? 'other') as (typeof roles)[number],
      };
    })
    .filter((token) => token.value);
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const database = db();
  const text = (key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

  const id = text('id', 40) || newId();
  const now = new Date().toISOString();
  const isDefault = form.get('isDefault') === 'yes';

  const sectionOrder = text('sectionOrder', 1000)
    .split(/[\n,]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);

  const values = {
    userId: user.id,
    name: text('name', 120) || 'Untitled direction',
    description: text('description', 1000),
    referenceUrls: JSON.stringify(parseReferences(text('referenceUrls', 6000))),
    typography: JSON.stringify(parseTypography(text('typography', 2000))),
    palette: JSON.stringify(parsePalette(text('palette', 2000))),
    sectionOrder: JSON.stringify(sectionOrder.length ? sectionOrder : DEFAULT_SECTION_ORDER),
    prompt: text('prompt', 8000),
    toneNotes: text('toneNotes', 3000),
    avoid: text('avoid', 3000),
    capabilities: text('capabilities', 3000),
    suitableFor: text('suitableFor', 500),
    isDefault,
    updatedAt: now,
  };

  const existing = await database
    .select({ id: brandKits.id })
    .from(brandKits)
    .where(and(eq(brandKits.id, id), eq(brandKits.userId, user.id)))
    .limit(1);

  if (existing[0]) {
    await database.update(brandKits).set(values).where(eq(brandKits.id, id));
  } else {
    await database.insert(brandKits).values({ id, createdAt: now, ...values });
  }

  // Exactly one default, or the resolution order stops being deterministic.
  if (isDefault) {
    await database
      .update(brandKits)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(brandKits.userId, user.id), ne(brandKits.id, id)));
  }

  /* -- Uploads ----------------------------------------------------- */

  const uploads = form.getAll('assets').filter((value): value is File => value instanceof File);
  const bucket = files();
  const rejected: string[] = [];

  for (const upload of uploads.slice(0, 12)) {
    if (upload.size === 0) continue;
    if (upload.size > MAX_UPLOAD_BYTES) {
      rejected.push(`${upload.name} is over 8 MB`);
      continue;
    }
    if (!ALLOWED_UPLOADS.has(upload.type)) {
      rejected.push(`${upload.name} is a ${upload.type || 'unknown type'}`);
      continue;
    }

    const assetId = newId();
    const key = brandAssetKey(user.id, assetId, safeSegment(upload.name));
    const stored = await putObject(bucket, key, await upload.arrayBuffer(), upload.type);

    await database.insert(brandAssets).values({
      id: assetId,
      userId: user.id,
      brandKitId: id,
      kind: upload.type.startsWith('font/')
        ? 'font'
        : upload.type === 'application/zip'
          ? 'template'
          : 'screenshot',
      label: upload.name.slice(0, 200),
      r2Key: stored.key,
      contentType: stored.contentType,
      bytes: stored.bytes,
      createdAt: now,
    });
  }

  const query = rejected.length
    ? `?error=${encodeURIComponent(`Saved, but skipped: ${rejected.join('; ')}.`)}`
    : '?saved=1';

  return redirect(`/growth/brand/${id}${query}`, 302);
};
