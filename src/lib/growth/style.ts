/**
 * The style spec: what a page looks like, decided per prospect.
 *
 * `DesignTokens` was the first attempt at this and it did not go far enough.
 * Eight enums, all set on the brand kit, meant that every demo in a run was
 * the same page in the same colours with different words in it — which is
 * exactly the complaint. The enums also lived too far from the measurements:
 * "airy" is not a number, so two kits that both said "airy" produced
 * identical spacing whatever their references actually did.
 *
 * A `StyleSpec` is the resolved answer for ONE demo. It carries the palette
 * and typefaces that page will use, the eight enums (kept, because they are
 * what a person edits in the UI), a set of real numbers for proportion, and a
 * set of composition choices that change the markup rather than just the CSS.
 * It is resolved in three passes, each one allowed to move the previous:
 *
 *   kit  →  references  →  model
 *
 * `styleFromBrief` gives the kit's answer, `deriveFromProfiles` moves it
 * toward what the reference sites measure, and `parseStyleSpec` takes the
 * model's proposal and clamps every field back into a range that is
 * guaranteed to lay out. The model therefore gets real authority over the
 * design without ever getting to write CSS: it returns JSON, every number is
 * range-checked, every enum is checked against its list, and every colour is
 * re-emitted from parsed components. A spec that fails validation degrades
 * field by field to the pass before it rather than failing the demo.
 *
 * What the model still never does is author markup. `render.ts` writes the
 * HTML, so every string from the model is escaped on the way in. That
 * guarantee is the reason this file exists in the shape it does.
 */

import type { Brief, ColourToken, DesignTokens, TypefaceSpec } from './brief';
import { DEFAULT_TOKENS, parseDesignTokens } from './brief';
import type { ReferenceProfile } from './reference';
import { contrastRatio, luminance, parseColour, safeFamilyName, saturation, toHex } from './reference';

/* ------------------------------------------------------------------ */
/* Shape                                                              */
/* ------------------------------------------------------------------ */

/**
 * Proportion, as numbers.
 *
 * Every field has a documented range, and the range is the contract: a value
 * inside it lays out at every width from 320px up, and `clampScale` puts
 * anything outside it back. The ranges are wide enough that two specs at
 * opposite ends do not look like the same page — that is the whole point —
 * and narrow enough that neither end is broken.
 */
export interface StyleScale {
  /** Page measure. 56–96rem. */
  maxWidthRem: number;
  /** Side padding. 1–3.5rem. */
  gutterRem: number;
  /** Space above and below a section. 2.5–11rem. */
  sectionGapRem: number;
  /** Padding inside a card. 0.9–3.2rem. */
  cardPadRem: number;
  /** 0–36px. */
  radiusCardPx: number;
  /** 0–40px. */
  radiusMediaPx: number;
  /** 0–999px; 999 is a pill. */
  radiusButtonPx: number;
  /** Hero headline, at the top of its clamp. 2–6.5rem. */
  h1Rem: number;
  /** Section headings. 1.35–3.6rem. */
  h2Rem: number;
  /** Card headings. 1–1.9rem. */
  h3Rem: number;
  /** Standfirst. 1–1.7rem. */
  ledeRem: number;
  /** Body copy. 0.95–1.2rem. */
  bodyRem: number;
  /** Display letter-spacing. -0.06–0.1em. */
  trackingEm: number;
  /** Display line-height. 0.88–1.45. */
  leading: number;
  /** Paragraph measure. 46–80ch. */
  measureCh: number;
  /** Heading weight. 300–900, in steps of 50. */
  headingWeight: number;
  /** Body line-height. 1.4–1.9. */
  bodyLeading: number;
}

/**
 * Composition, as choices that change the markup.
 *
 * These are the fields that stop two specs being the same layout in different
 * proportions. Each one has a branch in `render.ts`; adding a value here
 * without adding the branch there gets you the default, which is why they are
 * closed sets rather than free text.
 */
export interface StyleComposition {
  /** How headings are cased. */
  headingCase: 'sentence' | 'upper';
  /** How a card is drawn. */
  cardStyle: 'bordered' | 'filled' | 'plain' | 'elevated';
  /** Columns a card grid wants at full width. */
  cardColumns: 2 | 3 | 4;
  /** How a gallery is composed. */
  galleryPattern: 'grid' | 'mosaic' | 'filmstrip' | 'stagger';
  /** How a text section is laid out. */
  introLayout: 'split' | 'stacked' | 'offset' | 'wide';
  /** Where section headings sit. `alternating` flips by index. */
  sectionAlign: 'left' | 'centred' | 'alternating';
  /** What the accent colour is actually spent on. */
  accentUse: 'buttons' | 'rules' | 'headings' | 'blocks';
  /** The header's treatment. */
  navStyle: 'plain' | 'bordered' | 'underline';
  /** Whether a standfirst is set in muted or full-strength text. */
  ledeColour: 'muted' | 'text';
}

export interface StyleSpec {
  palette: ColourToken[];
  typography: TypefaceSpec[];
  tokens: DesignTokens;
  scale: StyleScale;
  composition: StyleComposition;
  /** One sentence on why it looks like this. For the UI, never the page. */
  rationale: string;
  /**
   * The last pass that moved it.
   *
   * `jev` is a typed judgement out of closed sets; `model` is a text model's
   * JSON, clamped. Both are per-prospect, but only one of them could not have
   * returned an option that does not exist.
   */
  source: 'kit' | 'references' | 'jev' | 'model';
}

/* ------------------------------------------------------------------ */
/* Ranges                                                             */
/* ------------------------------------------------------------------ */

type Range = readonly [min: number, max: number];

const SCALE_RANGES: { readonly [K in keyof StyleScale]: Range } = {
  maxWidthRem: [56, 96],
  gutterRem: [1, 3.5],
  sectionGapRem: [2.5, 11],
  cardPadRem: [0.9, 3.2],
  radiusCardPx: [0, 36],
  radiusMediaPx: [0, 40],
  radiusButtonPx: [0, 999],
  h1Rem: [2, 6.5],
  h2Rem: [1.35, 3.6],
  h3Rem: [1, 1.9],
  ledeRem: [1, 1.7],
  bodyRem: [0.95, 1.2],
  trackingEm: [-0.06, 0.1],
  leading: [0.88, 1.45],
  measureCh: [46, 80],
  headingWeight: [300, 900],
  bodyLeading: [1.4, 1.9],
};

const COMPOSITION_VALUES: { readonly [K in keyof StyleComposition]: readonly StyleComposition[K][] } = {
  headingCase: ['sentence', 'upper'],
  cardStyle: ['bordered', 'filled', 'plain', 'elevated'],
  cardColumns: [2, 3, 4],
  galleryPattern: ['grid', 'mosaic', 'filmstrip', 'stagger'],
  introLayout: ['split', 'stacked', 'offset', 'wide'],
  sectionAlign: ['left', 'centred', 'alternating'],
  accentUse: ['buttons', 'rules', 'headings', 'blocks'],
  navStyle: ['plain', 'bordered', 'underline'],
  ledeColour: ['muted', 'text'],
};

export const COMPOSITION_OPTIONS = COMPOSITION_VALUES;

const clamp = (value: number, [min, max]: Range): number =>
  Math.min(max, Math.max(min, value));

/** Round to a sensible number of places so emitted CSS is readable. */
const tidy = (value: number, places = 2): number =>
  Number.parseFloat(value.toFixed(places));

/* ------------------------------------------------------------------ */
/* Pass 1: the kit                                                    */
/* ------------------------------------------------------------------ */

/** The numbers the original eight enums stood for. */
const DENSITY_SCALE = {
  tight: { gutter: 1.25, section: 3.5, card: 1.25 },
  regular: { gutter: 1.5, section: 5.5, card: 1.75 },
  airy: { gutter: 2, section: 8, card: 2.25 },
} as const;

const TYPE_SCALE_NUMBERS = {
  restrained: { h1: 2.6, h2: 1.7, h3: 1.15, lede: 1.1, tracking: -0.005, leading: 1.2 },
  balanced: { h1: 3.4, h2: 2.1, h3: 1.3, lede: 1.2, tracking: -0.015, leading: 1.1 },
  dramatic: { h1: 4.8, h2: 2.8, h3: 1.45, lede: 1.35, tracking: -0.03, leading: 0.98 },
} as const;

const RADIUS_NUMBERS = {
  square: { card: 0, media: 0 },
  soft: { card: 10, media: 12 },
  round: { card: 22, media: 26 },
} as const;

const BUTTON_RADIUS_NUMBERS = { pill: 999, rounded: 10, square: 0 } as const;

/**
 * The spec a brand kit alone implies.
 *
 * This is the compatibility floor: with no references and no model, it
 * reproduces what `tokenCss` used to emit, so an existing kit keeps rendering
 * the page it rendered before.
 */
export function styleFromBrief(brief: Brief): StyleSpec {
  const tokens = brief.tokens ?? DEFAULT_TOKENS;
  const density = DENSITY_SCALE[tokens.density];
  const type = TYPE_SCALE_NUMBERS[tokens.typeScale];
  const radius = RADIUS_NUMBERS[tokens.radius];

  return {
    palette: brief.palette,
    typography: brief.typography,
    tokens,
    scale: {
      maxWidthRem: 76,
      gutterRem: density.gutter,
      sectionGapRem: density.section,
      cardPadRem: density.card,
      radiusCardPx: radius.card,
      radiusMediaPx: tokens.imagery === 'sharp' ? 0 : radius.media,
      radiusButtonPx: BUTTON_RADIUS_NUMBERS[tokens.button],
      h1Rem: type.h1,
      h2Rem: type.h2,
      h3Rem: type.h3,
      ledeRem: type.lede,
      bodyRem: 1.05,
      trackingEm: type.tracking,
      leading: type.leading,
      measureCh: 62,
      headingWeight: 600,
      bodyLeading: 1.65,
    },
    composition: {
      headingCase: 'sentence',
      cardStyle: 'bordered',
      cardColumns: 3,
      galleryPattern: 'mosaic',
      introLayout: 'split',
      sectionAlign: 'left',
      accentUse: tokens.accent === 'bold' ? 'buttons' : 'rules',
      navStyle: 'bordered',
      ledeColour: 'muted',
    },
    rationale: `The "${brief.name}" direction as saved.`,
    source: 'kit',
  };
}

/* ------------------------------------------------------------------ */
/* Pass 2: the references                                             */
/* ------------------------------------------------------------------ */

/**
 * Build a palette out of what the references actually use.
 *
 * Ranking is by role and then by how often a colour appears, because a colour
 * used once in a cookie banner is not the brand and a colour used ninety
 * times is. Two things then get enforced regardless of what was measured:
 * body text must clear 4.5:1 against the background, and the accent must
 * clear 3:1, because a concept sent to a stranger that cannot be read is
 * worse than one that looks like the template.
 */
export function paletteFromProfiles(profiles: ReferenceProfile[], fallback: ColourToken[]): ColourToken[] {
  const colours = profiles.filter((p) => p.ok).flatMap((p) => p.colours);
  if (colours.length < 3) return fallback;

  const byRole = (role: string) =>
    colours.filter((c) => c.role === role).sort((a, b) => b.hits - a.hits);

  const backgrounds = byRole('background');
  const texts = byRole('text');
  const borders = byRole('border');

  const fallbackValue = (name: string, fallbackHex: string): string =>
    fallback.find((c) => c.role === name)?.value ?? fallbackHex;

  /**
   * The page ground: the most-used background that is not a statement colour.
   *
   * Usage has to come first. Preferring the *lightest* background instead
   * picked the accent off a dark site — an acid yellow used seven times on
   * buttons beat a near-black used eighteen times on the page itself, and the
   * demo came out with a yellow ground and everything else pushed around to
   * stay legible against it. Saturation is the thing to screen on, not
   * lightness: a ground is a ground whether it is near-white or near-black,
   * and a colour saturated enough to shout was chosen to shout.
   */
  const ground =
    backgrounds.find((c) => c.saturation < 0.5) ??
    backgrounds.find((c) => c.saturation < 0.75) ??
    backgrounds[0];

  const bg = ground?.value ?? fallbackValue('background', '#ffffff');
  const bgRgb = parseColour(bg) ?? { r: 255, g: 255, b: 255 };
  const dark = luminance(bgRgb) < 0.5;

  // A surface has to be distinguishable from the ground without becoming a
  // second background; near-identical picks are dropped.
  const surface =
    backgrounds.find((c) => {
      if (c.value === bg) return false;
      const rgb = parseColour(c.value);
      if (!rgb) return false;
      const delta = Math.abs(luminance(rgb) - luminance(bgRgb));
      return delta > 0.02 && delta < 0.35;
    })?.value ?? shift(bg, dark ? 0.05 : -0.03);

  const readable = (candidates: typeof texts, minimum: number): string | null => {
    for (const candidate of candidates) {
      const rgb = parseColour(candidate.value);
      if (rgb && contrastRatio(rgb, bgRgb) >= minimum) return candidate.value;
    }
    return null;
  };

  const text = readable(texts, 4.5) ?? (dark ? '#f5f5f3' : '#16150f');
  const textRgb = parseColour(text) ?? { r: 22, g: 21, b: 15 };

  // Muted sits between text and ground, and still has to be legible.
  const muted =
    readable(
      texts.filter((c) => c.value !== text),
      3.2,
    ) ?? mix(text, bg, 0.42);

  // The accent is the most saturated colour anyone bothered to use twice —
  // saturation is what makes it read as a choice rather than as furniture.
  const accentCandidates = colours
    .filter((c) => c.saturation > 0.18 && c.hits >= 2)
    .sort((a, b) => b.saturation * Math.sqrt(b.hits) - a.saturation * Math.sqrt(a.hits));

  let accent = accentCandidates[0]?.value ?? fallbackValue('accent', '#1f6f5c');
  const accentRgb = parseColour(accent);
  if (!accentRgb || contrastRatio(accentRgb, bgRgb) < 3) {
    // Darken or lighten toward legibility rather than discarding the hue: the
    // hue is the part that came from the reference.
    accent = towardContrast(accent, bg, 3);
  }

  const border =
    borders.find((c) => {
      const rgb = parseColour(c.value);
      return rgb ? contrastRatio(rgb, bgRgb) < 4 && contrastRatio(rgb, bgRgb) > 1.05 : false;
    })?.value ?? mix(text, bg, 0.86);

  const tokens: ColourToken[] = [
    { name: 'bg', value: bg, role: 'background' },
    { name: 'surface', value: surface, role: 'surface' },
    { name: 'text', value: text, role: 'text' },
    { name: 'muted', value: muted, role: 'muted' },
    { name: 'accent', value: accent, role: 'accent' },
    { name: 'border', value: border, role: 'border' },
  ];

  return tokens.map((token) => ({ ...token, value: normaliseHex(token.value) }));
}

/** Normalise any parseable colour to `#rrggbb`; drop anything else. */
function normaliseHex(value: string): string {
  const rgb = parseColour(value);
  return rgb ? toHex(rgb) : '#000000';
}

/** Move a colour toward white (positive) or black (negative). */
function shift(value: string, amount: number): string {
  const rgb = parseColour(value) ?? { r: 255, g: 255, b: 255 };
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return toHex({
    r: rgb.r + (target - rgb.r) * t,
    g: rgb.g + (target - rgb.g) * t,
    b: rgb.b + (target - rgb.b) * t,
  });
}

/** Blend two colours. `t` is how much of `b` to take. */
function mix(a: string, b: string, t: number): string {
  const x = parseColour(a) ?? { r: 0, g: 0, b: 0 };
  const y = parseColour(b) ?? { r: 255, g: 255, b: 255 };
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

/**
 * Push a colour away from a background until it clears a contrast ratio,
 * keeping its hue. Gives up after a bounded walk and returns the best it
 * reached, which is still better than the colour it started from.
 */
function towardContrast(colour: string, against: string, minimum: number): string {
  const groundRgb = parseColour(against) ?? { r: 255, g: 255, b: 255 };
  const goDark = luminance(groundRgb) >= 0.5;

  let current = colour;
  for (let step = 0; step < 14; step += 1) {
    const rgb = parseColour(current);
    if (rgb && contrastRatio(rgb, groundRgb) >= minimum) return current;
    current = shift(current, goDark ? -0.12 : 0.12);
  }
  return current;
}

/**
 * Typefaces the references set.
 *
 * A family only becomes a `google` face when the reference itself loaded it
 * from Google Fonts, because that URL is known to exist. Anything else is
 * recorded as a `system` face: the family name goes first in the stack for
 * anyone who has it, and a real fallback carries everyone else. Inventing a
 * Google Fonts URL for a family that is not there would put a dead stylesheet
 * link on the page.
 */
export function typographyFromProfiles(
  profiles: ReferenceProfile[],
  fallback: TypefaceSpec[],
): TypefaceSpec[] {
  const usable = profiles.filter((p) => p.ok);
  if (!usable.length) return fallback;

  const faces = usable.flatMap((p) => p.faces);
  const serifish = usable.some((p) => p.traits.serifDisplay);

  const display = faces
    .filter((f) => f.headingHits > 0)
    .sort((a, b) => b.headingHits - a.headingHits || b.hits - a.hits)[0];

  const body = faces
    .filter((f) => f.headingHits === 0 && (!display || f.family !== display.family))
    .sort((a, b) => b.hits - a.hits)[0];

  const SERIF_FALLBACK = 'Georgia, "Times New Roman", serif';
  const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

  const build = (
    face: { family: string; googleUrl: string } | undefined,
    role: TypefaceSpec['role'],
    serif: boolean,
  ): TypefaceSpec | null => {
    if (!face) return null;
    const family = safeFamilyName(face.family);
    if (!family) return null;

    const google = face.googleUrl.startsWith('https://fonts.googleapis.com/');
    return {
      role,
      family,
      fallback: serif ? SERIF_FALLBACK : SANS_FALLBACK,
      source: google ? 'google' : 'system',
      url: google ? face.googleUrl : '',
      weights: [400, 500, 600, 700],
    };
  };

  const out = [
    build(display, 'display', serifish),
    build(body, 'body', false),
  ].filter((face): face is TypefaceSpec => face !== null);

  // A display face with no body face beside it would leave body copy on the
  // display family, which is not what the reference does either.
  if (!out.some((f) => f.role === 'body')) {
    const existing = fallback.find((f) => f.role === 'body');
    if (existing) out.push(existing);
  }

  return out.length ? out : fallback;
}

/**
 * Move a kit's spec toward what the references measure.
 *
 * Measurements only override where there is something to override with: a
 * reference that yielded no font sizes leaves the type scale where the kit
 * put it. That is what makes this safe to run on every brief.
 */
export function deriveFromProfiles(base: StyleSpec, profiles: ReferenceProfile[]): StyleSpec {
  const usable = profiles.filter((p) => p.ok);
  if (!usable.length) return base;

  const scale = { ...base.scale };
  const tokens = { ...base.tokens };
  const composition = { ...base.composition };
  const notes: string[] = [];

  // -- Type ------------------------------------------------------------
  const sizes = usable.flatMap((p) => p.fontSizesPx).sort((a, b) => b - a);
  // Two sizes is enough for a ratio, and a page that declares only a display
  // size and a body size is the well-controlled case rather than the thin one.
  if (sizes.length >= 2) {
    const largest = sizes[0]!;
    // The body size is the smallest size that is still plausibly body copy;
    // anything under 12px is a caption or a legal line.
    const bodyCandidates = sizes.filter((n) => n >= 13 && n <= 21);
    const bodyPx = bodyCandidates.length ? bodyCandidates[bodyCandidates.length - 1]! : 17;

    scale.h1Rem = largest / 16;
    scale.bodyRem = bodyPx / 16;

    const ratio = largest / bodyPx;
    scale.h2Rem = (bodyPx * Math.max(1.5, ratio * 0.62)) / 16;
    scale.h3Rem = (bodyPx * 1.25) / 16;
    scale.ledeRem = (bodyPx * 1.15) / 16;

    tokens.typeScale = ratio >= 3.4 ? 'dramatic' : ratio >= 2.2 ? 'balanced' : 'restrained';
    notes.push(`type scaled to the references' ${ratio.toFixed(1)}:1 ratio`);
  }

  const trackings = usable
    .map((p) => p.traits.headingTrackingEm)
    .filter((n): n is number => n !== null);
  if (trackings.length) {
    scale.trackingEm = trackings.reduce((a, b) => a + b, 0) / trackings.length;
  }

  if (usable.some((p) => p.traits.uppercaseHeadings)) {
    composition.headingCase = 'upper';
    notes.push('uppercase headings, as the references set them');
  }

  // -- Shape -----------------------------------------------------------
  const radii = usable.flatMap((p) => p.radiiPx);
  const corners = radii.filter((n) => n < 60);
  if (corners.length) {
    const typical = corners.sort((a, b) => a - b)[Math.floor(corners.length / 2)]!;
    scale.radiusCardPx = typical;
    scale.radiusMediaPx = typical;
    tokens.radius = typical < 3 ? 'square' : typical < 14 ? 'soft' : 'round';
    tokens.imagery = typical < 3 ? 'sharp' : 'rounded';
    notes.push(`${typical}px corners`);
  }
  if (radii.some((n) => n >= 100)) {
    scale.radiusButtonPx = 999;
    tokens.button = 'pill';
  } else if (corners.length) {
    scale.radiusButtonPx = scale.radiusCardPx;
    tokens.button = scale.radiusCardPx < 3 ? 'square' : 'rounded';
  }

  // -- Proportion ------------------------------------------------------
  const containers = usable
    .map((p) => p.traits.containerPx)
    .filter((n): n is number => n !== null);
  if (containers.length) {
    scale.maxWidthRem = Math.max(...containers) / 16;
    notes.push(`a ${Math.round(Math.max(...containers))}px measure`);
  }

  const paddings = usable
    .map((p) => p.traits.sectionPaddingPx)
    .filter((n): n is number => n !== null);
  if (paddings.length) {
    const typical = paddings.reduce((a, b) => a + b, 0) / paddings.length;
    scale.sectionGapRem = typical / 16;
    tokens.density = typical >= 96 ? 'airy' : typical >= 56 ? 'regular' : 'tight';
  }

  // -- Rhythm ----------------------------------------------------------
  // Two backgrounds in real use means the reference separates sections by
  // tint; one means it does it with rules or with space alone.
  const grounds = new Set(
    usable
      .flatMap((p) => p.colours)
      .filter((c) => c.role === 'background' && c.hits >= 3)
      .map((c) => c.value),
  );
  if (grounds.size >= 2) {
    tokens.rhythm = 'tint';
    composition.cardStyle = 'filled';
  } else if (usable.some((p) => p.colours.some((c) => c.role === 'border' && c.hits >= 4))) {
    tokens.rhythm = 'rules';
    composition.cardStyle = 'bordered';
  } else {
    tokens.rhythm = 'plain';
    composition.cardStyle = 'plain';
  }

  return {
    ...base,
    palette: paletteFromProfiles(profiles, base.palette),
    typography: typographyFromProfiles(profiles, base.typography),
    tokens: parseDesignTokens(tokens),
    scale: clampScale(scale),
    composition,
    rationale: notes.length
      ? `Measured off ${usable.length} reference${usable.length === 1 ? '' : 's'}: ${notes.join(', ')}.`
      : `Measured off ${usable.length} reference${usable.length === 1 ? '' : 's'}.`,
    source: 'references',
  };
}

/** The section order the references actually use, filtered to what we render. */
export function flowFromProfiles(profiles: ReferenceProfile[], allowed: Iterable<string>): string[] {
  const permitted = new Set(allowed);
  const out: string[] = [];

  for (const profile of profiles) {
    if (!profile.ok) continue;
    for (const type of profile.flow) {
      if (!permitted.has(type) || out.includes(type)) continue;
      out.push(type);
    }
  }

  // A flow without a hero or a way to make contact is not a page.
  if (out.length && !out.includes('hero')) out.unshift('hero');
  if (out.length && !out.includes('contact')) out.push('contact');

  return out.slice(0, 9);
}

/* ------------------------------------------------------------------ */
/* Pass 3: the model                                                  */
/* ------------------------------------------------------------------ */

export function clampScale(raw: Partial<StyleScale>, base?: StyleScale): StyleScale {
  const start = base ?? raw;
  const out = {} as StyleScale;

  for (const key of Object.keys(SCALE_RANGES) as Array<keyof StyleScale>) {
    const candidate = raw[key];
    const fallback = (start as StyleScale)[key];
    const value =
      typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
    out[key] = tidy(clamp(typeof value === 'number' && Number.isFinite(value) ? value : 0, SCALE_RANGES[key]), 3);
  }

  // Heading weight is a CSS keyword-adjacent number; snap it to a real step.
  out.headingWeight = Math.round(out.headingWeight / 50) * 50;

  /**
   * The scale has to stay a scale.
   *
   * A model that returns h2 larger than h1, or a lede larger than h3, has
   * produced numbers inside every range that still do not describe a
   * hierarchy. Ordering them is cheaper than rejecting the whole spec and
   * keeps the part the model got right.
   */
  out.h1Rem = Math.max(out.h1Rem, out.h2Rem * 1.05);
  out.h2Rem = Math.max(out.h2Rem, out.h3Rem * 1.1);
  out.h3Rem = Math.max(out.h3Rem, out.bodyRem * 1.05);
  out.ledeRem = Math.max(out.ledeRem, out.bodyRem);

  return out;
}

function clampComposition(raw: unknown, base: StyleComposition): StyleComposition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base };
  const source = raw as Record<string, unknown>;
  const out = { ...base };

  for (const key of Object.keys(COMPOSITION_VALUES) as Array<keyof StyleComposition>) {
    const allowed = COMPOSITION_VALUES[key] as readonly unknown[];
    let candidate = source[key];
    // `cardColumns` arrives as a number from JSON but may arrive as "3".
    if (key === 'cardColumns' && typeof candidate === 'string') {
      candidate = Number.parseInt(candidate, 10);
    }
    if (typeof candidate === 'string') candidate = candidate.trim().toLowerCase();
    if (allowed.includes(candidate)) {
      (out as Record<string, unknown>)[key] = candidate;
    }
  }

  return out;
}

const COLOUR_ROLES: ReadonlyArray<ColourToken['role']> = [
  'background',
  'surface',
  'text',
  'muted',
  'accent',
  'border',
  'other',
];

/**
 * Take a palette from the model.
 *
 * Every value is parsed and re-emitted from its components, so what reaches
 * the stylesheet is six hex triples this code wrote, never a string the model
 * did. Contrast is then enforced the same way it is for a measured palette:
 * the model gets to choose the hues, not to make the page unreadable.
 */
export function clampPalette(raw: unknown, base: ColourToken[]): ColourToken[] {
  if (!Array.isArray(raw)) return base;

  const byRole = new Map<string, string>();
  for (const entry of raw.slice(0, 12)) {
    if (!entry || typeof entry !== 'object') continue;
    const token = entry as Record<string, unknown>;
    const role = String(token.role ?? '').trim().toLowerCase();
    const rgb = parseColour(String(token.value ?? ''));
    if (!rgb) continue;
    if (!COLOUR_ROLES.includes(role as ColourToken['role'])) continue;
    if (!byRole.has(role)) byRole.set(role, toHex(rgb));
  }

  if (byRole.size < 3) return base;

  const pick = (role: string, fallback: string): string =>
    byRole.get(role) ?? base.find((c) => c.role === role)?.value ?? fallback;

  const bg = pick('background', '#ffffff');
  const bgRgb = parseColour(bg) ?? { r: 255, g: 255, b: 255 };
  const dark = luminance(bgRgb) < 0.5;

  const ensure = (value: string, minimum: number, fallback: string): string => {
    const rgb = parseColour(value);
    if (rgb && contrastRatio(rgb, bgRgb) >= minimum) return value;
    const pushed = towardContrast(value, bg, minimum);
    const pushedRgb = parseColour(pushed);
    return pushedRgb && contrastRatio(pushedRgb, bgRgb) >= minimum ? pushed : fallback;
  };

  const text = ensure(pick('text', dark ? '#f5f5f3' : '#16150f'), 4.5, dark ? '#ffffff' : '#000000');
  const accent = ensure(pick('accent', '#1f6f5c'), 3, dark ? '#ffffff' : '#000000');
  const muted = ensure(pick('muted', mix(text, bg, 0.42)), 3.2, mix(text, bg, 0.3));

  return [
    { name: 'bg', value: bg, role: 'background' as const },
    { name: 'surface', value: pick('surface', shift(bg, dark ? 0.05 : -0.03)), role: 'surface' as const },
    { name: 'text', value: text, role: 'text' as const },
    { name: 'muted', value: muted, role: 'muted' as const },
    { name: 'accent', value: accent, role: 'accent' as const },
    { name: 'border', value: pick('border', mix(text, bg, 0.86)), role: 'border' as const },
  ].map((token) => ({ ...token, value: normaliseHex(token.value) }));
}

/**
 * Take a typeface choice from the model.
 *
 * The model may only pick from the faces already on the table — the kit's own
 * and the ones measured off the references. It cannot name a family nobody has
 * loaded, because the page has no way to fetch it and the result would be a
 * fallback stack pretending to be a choice.
 */
export function clampTypography(
  raw: unknown,
  base: TypefaceSpec[],
  available: TypefaceSpec[],
): TypefaceSpec[] {
  if (!Array.isArray(raw)) return base;

  const pool = [...available, ...base];
  const out: TypefaceSpec[] = [];

  for (const entry of raw.slice(0, 4)) {
    if (!entry || typeof entry !== 'object') continue;
    const token = entry as Record<string, unknown>;
    const family = safeFamilyName(String(token.family ?? ''));
    const role = String(token.role ?? '').trim().toLowerCase();
    if (!family) continue;

    const match = pool.find((face) => face.family.toLowerCase() === family.toLowerCase());
    if (!match) continue;
    if (out.some((face) => face.role === match.role)) continue;

    out.push(
      role === 'display' || role === 'body' || role === 'heading'
        ? { ...match, role: role as TypefaceSpec['role'] }
        : match,
    );
  }

  return out.some((face) => face.role === 'body') ? out : base;
}

/**
 * Validate a whole spec proposed by a model, degrading field by field.
 *
 * Nothing here can fail: an unparseable field falls back to `base`, which is
 * the references pass, which falls back to the kit. The worst outcome of a bad
 * model response is the page the kit would have produced anyway.
 */
export function parseStyleSpec(
  raw: unknown,
  base: StyleSpec,
  available: { typography: TypefaceSpec[] },
): StyleSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const source = raw as Record<string, unknown>;

  const scale = clampScale(
    (source.scale && typeof source.scale === 'object' && !Array.isArray(source.scale)
      ? (source.scale as Partial<StyleScale>)
      : {}),
    base.scale,
  );

  return {
    palette: clampPalette(source.palette, base.palette),
    typography: clampTypography(source.typography, base.typography, available.typography),
    tokens: parseDesignTokens({ ...base.tokens, ...(source.tokens as object | undefined) }),
    scale,
    composition: clampComposition(source.composition, base.composition),
    rationale: String(source.rationale ?? '').trim().slice(0, 400) || base.rationale,
    source: 'model',
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */

export function serialiseStyle(spec: StyleSpec): string {
  return JSON.stringify(spec);
}

/** Re-read a stored spec, clamping it again on the way in. */
export function deserialiseStyle(raw: string | null | undefined, base: StyleSpec): StyleSpec {
  if (!raw) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  const spec = parseStyleSpec(parsed, base, { typography: base.typography });
  // `source` is a record of where it came from, not something to re-derive.
  const recorded = (parsed as Record<string, unknown> | null)?.source;
  const known: ReadonlyArray<StyleSpec['source']> = ['kit', 'references', 'jev', 'model'];
  return {
    ...spec,
    source: known.includes(recorded as StyleSpec['source'])
      ? (recorded as StyleSpec['source'])
      : spec.source,
  };
}

/* ------------------------------------------------------------------ */
/* The prompt                                                         */
/* ------------------------------------------------------------------ */

/** The ranges, written out for the model that has to stay inside them. */
export function renderStyleContract(): string {
  const ranges = (Object.keys(SCALE_RANGES) as Array<keyof StyleScale>)
    .map((key) => `    "${key}": ${SCALE_RANGES[key][0]}–${SCALE_RANGES[key][1]}`)
    .join(',\n');

  const options = (Object.keys(COMPOSITION_VALUES) as Array<keyof StyleComposition>)
    .map((key) => `    "${key}": ${(COMPOSITION_VALUES[key] as readonly unknown[]).map((v) => JSON.stringify(v)).join(' | ')}`)
    .join(',\n');

  return `Return ONLY JSON, in exactly this shape:

{
  "rationale": "one sentence on why this business gets this treatment",
  "palette": [
    { "role": "background", "value": "#rrggbb" },
    { "role": "surface", "value": "#rrggbb" },
    { "role": "text", "value": "#rrggbb" },
    { "role": "muted", "value": "#rrggbb" },
    { "role": "accent", "value": "#rrggbb" },
    { "role": "border", "value": "#rrggbb" }
  ],
  "typography": [
    { "role": "display", "family": "one of the families offered above" },
    { "role": "body", "family": "one of the families offered above" }
  ],
  "scale": {
${ranges}
  },
  "composition": {
${options}
  }
}

Every number must be inside the range shown. Every string must be one of the
values listed. Families must be one of the ones offered — you cannot name a
typeface that has not been loaded. Colours must be six-digit hex.`;
}

/** The spec, written out for a prompt or for the UI. */
export function describeStyle(spec: StyleSpec): string {
  const colour = (role: string): string =>
    spec.palette.find((c) => c.role === role)?.value ?? '—';

  return [
    `Palette: bg ${colour('background')}, text ${colour('text')}, accent ${colour('accent')}`,
    `Type: ${spec.typography.map((f) => `${f.family} (${f.role})`).join(', ') || '—'}`,
    `Scale: h1 ${spec.scale.h1Rem}rem over ${spec.scale.bodyRem}rem body, ` +
      `${spec.scale.sectionGapRem}rem sections, ${spec.scale.radiusCardPx}px corners`,
    `Composition: ${spec.tokens.hero} hero, ${spec.composition.introLayout} text sections, ` +
      `${spec.composition.cardColumns}-up ${spec.composition.cardStyle} cards, ` +
      `${spec.composition.galleryPattern} gallery, accent on ${spec.composition.accentUse}`,
  ].join('\n');
}
