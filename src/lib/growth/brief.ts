/**
 * The design brief: everything the generator is told about how the work
 * should look and sound.
 *
 * A brief is a saved brand kit with an optional per-run override layer on
 * top, so you can channel one niche for a single campaign without editing
 * the defaults you use the rest of the time. Overrides are shallow by field:
 * an override that sets `palette` replaces the palette wholesale rather than
 * merging colour by colour, because half-merged palettes look like neither
 * choice.
 *
 * Everything here is data the model is *shown*. None of it is trusted as
 * instruction — see `renderBriefPrompt`, which frames it as reference
 * material precisely because some of it (reference site titles, for one)
 * originates outside this app.
 */

import type { BrandKit } from '../db/schema';

export interface ReferenceSite {
  url: string;
  note: string;
}

export interface TypefaceSpec {
  /** Where it is used. */
  role: 'display' | 'heading' | 'body' | 'mono' | 'accent';
  family: string;
  /** Rendered into the CSS stack after `family`. */
  fallback: string;
  source: 'google' | 'system' | 'self-hosted';
  /** Stylesheet URL for `google`, or the font file for `self-hosted`. */
  url: string;
  weights: number[];
}

export interface ColourToken {
  /** CSS custom property name, without the leading dashes. */
  name: string;
  /** Any valid CSS colour. */
  value: string;
  role: 'background' | 'surface' | 'text' | 'muted' | 'accent' | 'border' | 'other';
}

export interface Brief {
  brandKitId: string | null;
  name: string;
  references: ReferenceSite[];
  typography: TypefaceSpec[];
  palette: ColourToken[];
  sectionOrder: string[];
  /** The art-direction block, shown to the model verbatim. */
  direction: string;
  tone: string;
  avoid: string;
  capabilities: string;
  /** R2 keys of screenshots and templates attached to the kit or the run. */
  assetKeys: string[];
}

export const DEFAULT_SECTION_ORDER = [
  'hero',
  'intro',
  'services',
  'gallery',
  'testimonials',
  'about',
  'location',
  'contact',
];

/**
 * A usable brief when nothing has been configured yet. Restrained on
 * purpose: a generated demo that overreaches on style is harder to show a
 * stranger than one that is merely clean.
 */
export const FALLBACK_BRIEF: Brief = {
  brandKitId: null,
  name: 'Default',
  references: [],
  typography: [
    {
      role: 'display',
      family: 'Fraunces',
      fallback: 'Georgia, "Times New Roman", serif',
      source: 'google',
      url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap',
      weights: [400, 600],
    },
    {
      role: 'body',
      family: 'Inter',
      fallback: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      source: 'google',
      url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
      weights: [400, 500, 600],
    },
  ],
  palette: [
    { name: 'bg', value: '#fbfaf7', role: 'background' },
    { name: 'surface', value: '#ffffff', role: 'surface' },
    { name: 'text', value: '#1b1a17', role: 'text' },
    { name: 'muted', value: '#6b6760', role: 'muted' },
    { name: 'accent', value: '#1f6f5c', role: 'accent' },
    { name: 'border', value: '#e6e2da', role: 'border' },
  ],
  sectionOrder: DEFAULT_SECTION_ORDER,
  direction:
    'Generous whitespace, a single strong accent colour, large confident type and real photography over stock. ' +
    'One clear action per screen. Nothing decorative that does not earn its place.',
  tone: 'Plain, warm and specific. Short sentences. No marketing superlatives.',
  avoid:
    'Stock-photo handshakes, gradient blobs, carousels, auto-playing video, cookie-banner clutter, ' +
    '"we are passionate about", any claim about the business we cannot verify.',
  capabilities: 'Brand identity, web design and build, print collateral, photography direction.',
  assetKeys: [],
};

function parseArray<T>(raw: string | null | undefined, guard: (value: unknown) => value is T): T[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(guard) : [];
}

const isReference = (v: unknown): v is ReferenceSite =>
  !!v && typeof v === 'object' && typeof (v as ReferenceSite).url === 'string';

const isTypeface = (v: unknown): v is TypefaceSpec =>
  !!v && typeof v === 'object' && typeof (v as TypefaceSpec).family === 'string';

const isColour = (v: unknown): v is ColourToken =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ColourToken).name === 'string' &&
  typeof (v as ColourToken).value === 'string';

const isString = (v: unknown): v is string => typeof v === 'string';

export function briefFromKit(kit: BrandKit | null): Brief {
  if (!kit) return { ...FALLBACK_BRIEF };

  const typography = parseArray(kit.typography, isTypeface);
  const palette = parseArray(kit.palette, isColour);
  const sectionOrder = parseArray(kit.sectionOrder, isString);

  return {
    brandKitId: kit.id,
    name: kit.name,
    references: parseArray(kit.referenceUrls, isReference),
    typography: typography.length ? typography : FALLBACK_BRIEF.typography,
    palette: palette.length ? palette : FALLBACK_BRIEF.palette,
    sectionOrder: sectionOrder.length ? sectionOrder : DEFAULT_SECTION_ORDER,
    direction: kit.prompt || FALLBACK_BRIEF.direction,
    tone: kit.toneNotes || FALLBACK_BRIEF.tone,
    avoid: kit.avoid || FALLBACK_BRIEF.avoid,
    capabilities: kit.capabilities || FALLBACK_BRIEF.capabilities,
    assetKeys: [],
  };
}

/**
 * Per-run overrides. Any field present replaces the kit's; absent and empty
 * fields leave the kit alone, so a run that only wants different type does
 * not have to restate the whole brief.
 */
export function applyOverrides(brief: Brief, raw: string | null | undefined): Brief {
  if (!raw) return brief;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return brief;
    parsed = value as Record<string, unknown>;
  } catch {
    return brief;
  }

  const next = { ...brief };
  const references = parseArrayValue(parsed.references, isReference);
  const typography = parseArrayValue(parsed.typography, isTypeface);
  const palette = parseArrayValue(parsed.palette, isColour);
  const sectionOrder = parseArrayValue(parsed.sectionOrder, isString);
  const assetKeys = parseArrayValue(parsed.assetKeys, isString);

  if (references.length) next.references = [...brief.references, ...references];
  if (typography.length) next.typography = typography;
  if (palette.length) next.palette = palette;
  if (sectionOrder.length) next.sectionOrder = sectionOrder;
  if (assetKeys.length) next.assetKeys = [...brief.assetKeys, ...assetKeys];

  for (const field of ['direction', 'tone', 'avoid', 'capabilities'] as const) {
    const value = parsed[field];
    if (typeof value === 'string' && value.trim()) next[field] = value.trim();
  }

  return next;
}

function parseArrayValue<T>(value: unknown, guard: (v: unknown) => v is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : [];
}

/**
 * Render the brief as reference material for a prompt.
 *
 * Framed as data rather than instruction: reference notes and kit text can
 * contain anything, including a sentence shaped like an order. Saying so up
 * front costs a few tokens and closes off the obvious injection.
 */
export function renderBriefPrompt(brief: Brief): string {
  const lines: string[] = ['<brief>'];

  if (brief.direction) lines.push(`Art direction: ${brief.direction}`);
  if (brief.tone) lines.push(`Voice: ${brief.tone}`);
  if (brief.avoid) lines.push(`Never: ${brief.avoid}`);
  if (brief.capabilities) lines.push(`The designer can deliver: ${brief.capabilities}`);

  if (brief.typography.length) {
    lines.push(
      'Typefaces: ' +
        brief.typography.map((t) => `${t.family} (${t.role})`).join(', ') +
        '. Use these and no others.',
    );
  }

  if (brief.palette.length) {
    lines.push(
      'Palette tokens: ' +
        brief.palette.map((c) => `--${c.name} ${c.value} (${c.role})`).join(', ') +
        '. Refer to them by token name.',
    );
  }

  if (brief.sectionOrder.length) {
    lines.push(`Preferred section order: ${brief.sectionOrder.join(' → ')}.`);
  }

  if (brief.references.length) {
    lines.push(
      'Reference sites for feel: ' +
        brief.references.map((r) => (r.note ? `${r.url} (${r.note})` : r.url)).join(', '),
    );
  }

  lines.push('</brief>');
  return lines.join('\n');
}

/** Turn the brief's palette into the CSS custom properties the build uses. */
export function paletteCss(brief: Brief): string {
  return brief.palette.map((c) => `    --${c.name}: ${c.value};`).join('\n');
}

/** Font stack for a role, falling back through the roles that usually stand in. */
export function fontStack(brief: Brief, role: TypefaceSpec['role']): string {
  const order: TypefaceSpec['role'][] =
    role === 'display' ? ['display', 'heading', 'body'] : role === 'heading' ? ['heading', 'display', 'body'] : [role, 'body'];

  for (const candidate of order) {
    const face = brief.typography.find((t) => t.role === candidate);
    if (face) return `'${face.family}', ${face.fallback}`;
  }
  return FALLBACK_BRIEF.typography[1]!.fallback;
}

/** The Google Fonts stylesheet links a generated page needs, deduplicated. */
export function fontLinks(brief: Brief): string[] {
  const seen = new Set<string>();
  for (const face of brief.typography) {
    if (face.source === 'google' && face.url.startsWith('https://fonts.googleapis.com/')) {
      seen.add(face.url);
    }
  }
  return [...seen];
}
