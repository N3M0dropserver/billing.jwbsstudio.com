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
import type { ReferenceProfile } from './reference';
import { parseProfiles, renderReferencePrompt } from './reference';

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

/**
 * The layout half of a kit.
 *
 * Palette and typefaces alone do not make two brand kits produce pages that
 * look different from each other — swap the colours on a fixed template and
 * you get the same template in new colours, which is exactly the complaint
 * that these exist to answer. These are the knobs that change composition:
 * proportion, rhythm, shape and how far the type is pushed.
 *
 * Every value is a closed set rather than free CSS. The renderer has to be
 * able to guarantee the result is laid out properly at every width, and a
 * kit that could inject arbitrary declarations could not promise that.
 */
export interface DesignTokens {
  /** Corner treatment across the page. */
  radius: 'square' | 'soft' | 'round';
  /** How much air sections are given. */
  density: 'tight' | 'regular' | 'airy';
  /** How far display type is pushed against body type. */
  typeScale: 'restrained' | 'balanced' | 'dramatic';
  /** How the hero is composed. */
  hero: 'split' | 'stacked' | 'full-bleed' | 'editorial';
  /** How one section is told from the next. */
  rhythm: 'rules' | 'tint' | 'plain';
  /** How photographs are framed. */
  imagery: 'sharp' | 'rounded' | 'arch';
  /** Eyebrows and small labels. */
  accent: 'quiet' | 'bold';
  /** Button shape. */
  button: 'pill' | 'rounded' | 'square';
}

export const DEFAULT_TOKENS: DesignTokens = {
  radius: 'soft',
  density: 'regular',
  typeScale: 'balanced',
  hero: 'split',
  rhythm: 'rules',
  imagery: 'rounded',
  accent: 'bold',
  button: 'pill',
};

/** The permitted values, used to validate whatever was saved or overridden. */
const TOKEN_VALUES: { [K in keyof DesignTokens]: readonly DesignTokens[K][] } = {
  radius: ['square', 'soft', 'round'],
  density: ['tight', 'regular', 'airy'],
  typeScale: ['restrained', 'balanced', 'dramatic'],
  hero: ['split', 'stacked', 'full-bleed', 'editorial'],
  rhythm: ['rules', 'tint', 'plain'],
  imagery: ['sharp', 'rounded', 'arch'],
  accent: ['quiet', 'bold'],
  button: ['pill', 'rounded', 'square'],
};

export const TOKEN_OPTIONS: { [K in keyof DesignTokens]: readonly DesignTokens[K][] } = TOKEN_VALUES;

/**
 * Coerce stored or overridden tokens into a complete, valid set.
 *
 * Anything unrecognised falls back to the default for that field rather than
 * failing: a kit saved by an older version of the app, or hand-edited to
 * something that no longer exists, should still render a page.
 */
export function parseDesignTokens(value: unknown): DesignTokens {
  const source =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;

  if (!source || typeof source !== 'object' || Array.isArray(source)) return { ...DEFAULT_TOKENS };

  const raw = source as Record<string, unknown>;
  const tokens = { ...DEFAULT_TOKENS };

  for (const key of Object.keys(TOKEN_VALUES) as Array<keyof DesignTokens>) {
    const candidate = raw[key];
    const allowed = TOKEN_VALUES[key] as readonly string[];
    if (typeof candidate === 'string' && allowed.includes(candidate)) {
      // Each key's value is checked against that key's own list, so the cast
      // is sound even though TypeScript cannot follow it through the index.
      (tokens as Record<string, string>)[key] = candidate;
    }
  }

  return tokens;
}

export interface Brief {
  brandKitId: string | null;
  name: string;
  references: ReferenceSite[];
  /**
   * What those references actually measure out to, when they have been read.
   *
   * Empty until the brief stage has profiled them. A URL on its own tells the
   * model nothing it can act on — see `reference.ts`.
   */
  referenceProfiles: ReferenceProfile[];
  typography: TypefaceSpec[];
  palette: ColourToken[];
  /** Composition, shape and proportion. See `DesignTokens`. */
  tokens: DesignTokens;
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
  referenceProfiles: [],
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
  tokens: DEFAULT_TOKENS,
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
    referenceProfiles: parseProfiles(kit.referenceProfiles),
    typography: typography.length ? typography : FALLBACK_BRIEF.typography,
    palette: palette.length ? palette : FALLBACK_BRIEF.palette,
    tokens: parseDesignTokens(kit.designTokens),
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

  // Tokens merge field by field rather than wholesale: overriding the hero
  // treatment for one campaign should not silently reset the rest.
  if (parsed.tokens && typeof parsed.tokens === 'object') {
    next.tokens = parseDesignTokens({ ...brief.tokens, ...(parsed.tokens as object) });
  }

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

  // The layout is fixed by the kit, not chosen by the model — but the copy
  // has to suit it. A full-bleed hero needs a short headline; an editorial
  // one can carry a longer one.
  lines.push(
    `Layout: a ${brief.tokens.hero} hero, ${brief.tokens.density} spacing, ` +
      `${brief.tokens.typeScale} type. Write headings that suit it.`,
  );

  /**
   * The references, named but not described.
   *
   * A bare list of URLs used to be all the model got, which was useless: it
   * has no browser, so "aim for the feel of example.com" was an address it
   * could not open. The measurements are rendered separately by
   * `renderReferencePrompt`, which callers put next to this block — so all
   * that is worth saying here is which sites they are and why, and only when
   * there are no measurements to say it better.
   */
  if (brief.references.length && !brief.referenceProfiles.some((profile) => profile.ok)) {
    lines.push(
      'Reference sites the designer chose (not yet measured, so treat the notes as ' +
        'the only guide): ' +
        brief.references.map((r) => (r.note ? `${r.url} (${r.note})` : r.url)).join(', '),
    );
  }

  lines.push('</brief>');
  return lines.join('\n');
}

/** The brief and its measured references, as one block for a prompt. */
export function renderBriefWithReferences(brief: Brief): string {
  return [renderBriefPrompt(brief), renderReferencePrompt(brief.referenceProfiles)]
    .filter(Boolean)
    .join('\n');
}

/** Turn the brief's palette into the CSS custom properties the build uses. */
export function paletteCss(brief: Brief): string {
  return brief.palette.map((c) => `    --${c.name}: ${c.value};`).join('\n');
}

/**
 * Font stack for a role, falling back through the roles that usually stand in.
 *
 * Takes the faces rather than the brief, because a rendered page's typefaces
 * may have come from a resolved style spec — measured off a reference site or
 * chosen per prospect — rather than straight off the kit.
 */
export function fontStackFrom(faces: TypefaceSpec[], role: TypefaceSpec['role']): string {
  const order: TypefaceSpec['role'][] =
    role === 'display' ? ['display', 'heading', 'body'] : role === 'heading' ? ['heading', 'display', 'body'] : [role, 'body'];

  for (const candidate of order) {
    const face = faces.find((t) => t.role === candidate);
    if (face) return `'${face.family}', ${face.fallback}`;
  }
  return FALLBACK_BRIEF.typography[1]!.fallback;
}

export function fontStack(brief: Brief, role: TypefaceSpec['role']): string {
  return fontStackFrom(brief.typography, role);
}

/** The Google Fonts stylesheet links a generated page needs, deduplicated. */
export function fontLinksFrom(faces: TypefaceSpec[]): string[] {
  const seen = new Set<string>();
  for (const face of faces) {
    if (face.source === 'google' && face.url.startsWith('https://fonts.googleapis.com/')) {
      seen.add(face.url);
    }
  }
  return [...seen];
}

export function fontLinks(brief: Brief): string[] {
  return fontLinksFrom(brief.typography);
}
