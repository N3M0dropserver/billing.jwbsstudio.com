/**
 * Turning a design plan into a page.
 *
 * The model writes the *spec* — headings, copy, section order, the pitch.
 * This file writes the HTML. That split is deliberate and worth keeping:
 *
 *   - Every string from the model passes through `escape` before it reaches
 *     markup, so a section heading cannot become a script tag. If the model
 *     authored the HTML there would be nothing to escape it with.
 *   - The layout, spacing, type scale and colour handling stay consistent
 *     across every demo, because they are written once here rather than
 *     re-improvised per prospect.
 *   - When the output is wrong you fix it in one place and every future
 *     demo is fixed, rather than rerolling a prompt.
 *
 * What that split originally got wrong was treating "consistent" as "one
 * fixed template". The brief's palette and typefaces reached the page but its
 * *composition* did not, so every demo had the same hero, the same rhythm and
 * the same proportions whatever kit produced it. Eight enums on the brand kit
 * fixed some of that and not enough of it: they were set per KIT, so every
 * demo in a run still came out the same page in the same colours.
 *
 * So everything visual now comes from a `StyleSpec`, resolved per prospect
 * (see `style.ts`). The spec carries real numbers for proportion, a palette
 * and typefaces that may have been measured off the designer's reference
 * sites, and composition choices that pick between the layout branches
 * below. A model is allowed to author it — and only it. It still never writes
 * markup, so the escaping guarantee above is untouched: every value arriving
 * here has been range-checked, and every colour re-emitted from parsed
 * components, before it reaches a declaration.
 *
 * Output is a single self-contained HTML file plus its stylesheet: no build
 * step, no framework, no JavaScript at all.
 */

import type { Brief, ColourToken, DesignTokens } from './brief';
import { fontLinksFrom, fontStackFrom } from './brief';
import type { DesignPlanDraft, PlanSection } from './qualify';
import { luminance, parseColour } from './reference';
import type { StyleSpec } from './style';
import { styleFromBrief } from './style';

export function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for inside a CSS value, where markup escaping does not apply. */
function cssSafe(value: string): string {
  return value.replace(/[<>{}\;"]/g, '').slice(0, 200);
}

/**
 * A picture on the finished page.
 *
 * `generated` is carried all the way to the markup on purpose. A concept sent
 * to a business that has never spoken to us must not imply we photographed
 * their premises, so anything we made is labelled where a reader will see it.
 */
export interface DemoPageImage {
  /** Path relative to the page. */
  src: string;
  alt: string;
  generated: boolean;
  /** The plan section this belongs to. */
  sectionId: string;
  role: 'hero' | 'feature' | 'gallery';
}

export interface DemoContext {
  businessName: string;
  niche: string;
  region: string;
  contact: { email: string; phone: string; address: string };
  socials: Array<{ platform: string; url: string }>;
  /**
   * Their photography and ours, as paths RELATIVE to the page.
   *
   * Relative rather than root-absolute so one set of files serves both the
   * subdomain (`wells.demo.example/`) and the path mount on the app's own
   * origin (`billing.example/d/wells.demo.example/`) without rewriting.
   */
  images: DemoPageImage[];
  openingHours: string[];
  /** Who to credit, shown in the demo ribbon. */
  designerName: string;
  designerUrl: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  contentType: string;
}

/* ------------------------------------------------------------------ */
/* The style spec as CSS                                               */
/* ------------------------------------------------------------------ */

/**
 * A fluid length between two rem values.
 *
 * Every size the spec carries is the value at a comfortable desktop width;
 * the page still has to work at 320px, so each one is emitted as a clamp
 * rather than a fixed size. The coefficients solve `a + b·vw` for `min` at
 * 22rem of viewport and `max` at 90rem, which is the range a concept is
 * actually looked at across.
 *
 * Doing this arithmetically rather than from a table of hand-written clamps
 * is what lets the scale be numbers at all — and numbers are what let a
 * measured reference or a model move it by a little rather than by a whole
 * step.
 */
function fluid(min: number, max: number): string {
  if (!(max > min)) return `${round(max)}rem`;

  const b = (max - min) / 0.68;
  const a = min - 0.22 * b;

  const offset = a === 0 ? '' : `${round(a)}rem + `;
  return `clamp(${round(min)}rem, ${offset}${round(b)}vw, ${round(max)}rem)`;
}

const round = (value: number): number => Number.parseFloat(value.toFixed(3));

/**
 * How a photograph is framed.
 *
 * `arch` is the one treatment that is a shape rather than a radius — a
 * rounded top on a tall frame. It is the cheapest way to make a page not look
 * like every other generated page, and it costs one declaration.
 */
const IMAGERY_FRAME: Record<DesignTokens['imagery'], string> = {
  sharp: '0',
  rounded: 'var(--radius-media)',
  arch: 'calc(var(--frame-width, 20rem) / 2) calc(var(--frame-width, 20rem) / 2) var(--radius-media) var(--radius-media)',
};

/**
 * The spec's numbers, as custom properties.
 *
 * Everything downstream in the stylesheet is written against these names, so
 * the whole visual result of one demo is decided by this block. Two specs that
 * differ produce pages that differ, which is the property the eight enums on
 * their own never had.
 */
export function styleVars(spec: StyleSpec): string {
  const { scale, tokens } = spec;

  return [
    `    --measure-page: ${round(scale.maxWidthRem)}rem;`,
    `    --gutter: ${fluid(Math.min(1, scale.gutterRem), scale.gutterRem)};`,
    `    --section-gap: ${fluid(Math.max(2, scale.sectionGapRem * 0.45), scale.sectionGapRem)};`,
    `    --card-pad: ${fluid(Math.max(0.85, scale.cardPadRem * 0.72), scale.cardPadRem)};`,
    `    --radius-card: ${round(scale.radiusCardPx)}px;`,
    `    --radius-media: ${round(scale.radiusMediaPx)}px;`,
    `    --radius-button: ${round(scale.radiusButtonPx)}px;`,
    `    --frame: ${IMAGERY_FRAME[tokens.imagery]};`,
    `    --h1: ${fluid(Math.max(1.75, scale.h1Rem * 0.46), scale.h1Rem)};`,
    `    --h2: ${fluid(Math.max(1.4, scale.h2Rem * 0.62), scale.h2Rem)};`,
    `    --h3: ${fluid(Math.max(1.05, scale.h3Rem * 0.86), scale.h3Rem)};`,
    `    --lede: ${fluid(Math.max(1, scale.ledeRem * 0.88), scale.ledeRem)};`,
    `    --body-size: ${fluid(Math.max(0.95, scale.bodyRem * 0.94), scale.bodyRem)};`,
    `    --body-leading: ${round(scale.bodyLeading)};`,
    `    --display-tracking: ${round(scale.trackingEm)}em;`,
    `    --display-leading: ${round(scale.leading)};`,
    `    --display-weight: ${scale.headingWeight};`,
    `    --measure: ${Math.round(scale.measureCh)}ch;`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Stylesheet                                                          */
/* ------------------------------------------------------------------ */

/** The role aliases the stylesheet is written against, whatever a kit named its tokens. */
const ROLE_ALIASES = ['bg', 'surface', 'text', 'muted', 'accent', 'line'];

function paletteBlock(palette: ColourToken[]): string {
  const named = new Map(palette.map((c) => [c.role, c.value]));

  // A kit's own token names are emitted too, so its `--brand-ink` is
  // available — but not where the name is already one of the aliases below,
  // which would declare the same property twice with the same value.
  const byName = palette
    .filter((c) => !ROLE_ALIASES.includes(cssSafe(c.name)))
    .map((c) => `    --${cssSafe(c.name)}: ${cssSafe(c.value)};`)
    .join('\n');

  // Role aliases so the stylesheet can be written against stable names
  // whatever the kit chose to call its tokens.
  const roles = [
    `    --bg: ${cssSafe(named.get('background') ?? '#ffffff')};`,
    `    --surface: ${cssSafe(named.get('surface') ?? named.get('background') ?? '#ffffff')};`,
    `    --text: ${cssSafe(named.get('text') ?? '#161616')};`,
    `    --muted: ${cssSafe(named.get('muted') ?? '#6b6b6b')};`,
    `    --accent: ${cssSafe(named.get('accent') ?? '#1f6f5c')};`,
    `    --line: ${cssSafe(named.get('border') ?? 'rgba(0,0,0,0.12)')};`,
  ].join('\n');

  return byName ? `${byName}\n${roles}` : roles;
}

/**
 * The composition half of the stylesheet.
 *
 * These are the declarations that differ because a `StyleComposition` field
 * differs. Kept in one function so that adding a value to a closed set in
 * `style.ts` has one obvious place to be honoured — a value with no branch
 * here silently renders as the default, which is the failure this file has
 * already made once.
 */
function compositionCss(spec: StyleSpec): string {
  const { composition, tokens } = spec;

  /**
   * Section separation.
   *
   * `rules` draws a hairline, `tint` alternates the surface colour and draws
   * nothing, `plain` relies on the spacing alone. Mixing a rule with a tint
   * reads as a seam rather than a change of gear, so they are exclusive.
   */
  const rhythm =
    tokens.rhythm === 'rules'
      ? '.section + .section { border-top: 1px solid var(--line); }'
      : tokens.rhythm === 'tint'
        ? '.section--tint { background: var(--surface); }'
        : '/* Sections are separated by space alone. */';

  const eyebrow =
    tokens.accent === 'bold'
      ? `.eyebrow {
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
}`
      : `.eyebrow {
    font-size: 0.9rem;
    letter-spacing: 0.01em;
    font-weight: 500;
}`;

  const headingCase =
    composition.headingCase === 'upper'
      ? `h1, h2, h3 { text-transform: uppercase; }`
      : '/* Headings are set as written. */';

  /**
   * How a card is drawn.
   *
   * `plain` is the one that changes the page most: with no border and no fill,
   * a three-up grid reads as three columns of text rather than three boxes,
   * which is how most editorial sites actually set a services list.
   */
  const card =
    composition.cardStyle === 'filled'
      ? `.card { background: var(--surface); border: 1px solid transparent; }`
      : composition.cardStyle === 'elevated'
        ? `.card { background: var(--surface); border: 1px solid transparent; box-shadow: 0 1px 2px color-mix(in srgb, var(--text) 8%, transparent), 0 12px 28px -12px color-mix(in srgb, var(--text) 18%, transparent); }`
        : composition.cardStyle === 'plain'
          ? `.card { background: transparent; border: 0; padding-inline: 0; padding-block: 0; }
.cards { gap: clamp(2rem, 4vw, 3.25rem); }`
          : `.card { background: var(--surface); border: 1px solid var(--line); }`;

  const columns =
    composition.cardColumns === 2
      ? `@media (min-width: 42rem) { .cards { grid-template-columns: repeat(2, 1fr); } }`
      : composition.cardColumns === 4
        ? `@media (min-width: 42rem) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 66rem) { .cards { grid-template-columns: repeat(4, 1fr); } }`
        : `@media (min-width: 42rem) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 66rem) { .cards { grid-template-columns: repeat(3, 1fr); } }`;

  /**
   * How a gallery is composed.
   *
   * `mosaic` promotes the first picture to a double-width lead, `filmstrip`
   * scrolls one row, `stagger` drops every second frame to break the grid
   * line, `grid` is an even grid. The first of these was the only behaviour
   * the renderer had, and it was a large part of why every demo's gallery
   * looked the same.
   */
  const gallery =
    composition.galleryPattern === 'grid'
      ? `.gallery { grid-template-columns: repeat(2, 1fr); }
@media (min-width: 60rem) { .gallery { grid-template-columns: repeat(3, 1fr); } }
.gallery .frame { aspect-ratio: 1; }`
      : composition.galleryPattern === 'filmstrip'
        ? `.gallery {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(16rem, 24rem);
    grid-template-columns: none;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding-bottom: 1rem;
    scrollbar-width: thin;
}
.gallery .frame { aspect-ratio: 4 / 5; scroll-snap-align: start; }`
        : composition.galleryPattern === 'stagger'
          ? `.gallery { grid-template-columns: repeat(2, 1fr); align-items: start; }
@media (min-width: 60rem) { .gallery { grid-template-columns: repeat(3, 1fr); } }
.gallery .frame { aspect-ratio: 4 / 5; }
@media (min-width: 60rem) {
    .gallery .frame:nth-child(even) { transform: translateY(clamp(1.5rem, 4vw, 3.5rem)); }
}
@media (prefers-reduced-motion: reduce) { .gallery .frame:nth-child(even) { transform: none; } }`
          : `.gallery { grid-template-columns: repeat(2, 1fr); }
@media (min-width: 60rem) { .gallery { grid-template-columns: repeat(3, 1fr); } }
.gallery .frame { aspect-ratio: 1; }
.gallery .frame:first-child { grid-column: span 2; aspect-ratio: 2; }
@media (min-width: 60rem) { .gallery .frame:first-child { aspect-ratio: 2 / 1; } }`;

  /** How a text section divides its column. */
  const intro =
    composition.introLayout === 'stacked'
      ? `.split { grid-template-columns: 1fr; max-width: 54rem; }`
      : composition.introLayout === 'offset'
        ? `@media (min-width: 58rem) { .split { grid-template-columns: 1fr 1.6fr; } .split > :first-child { position: sticky; top: 6rem; } }`
        : composition.introLayout === 'wide'
          ? `@media (min-width: 58rem) { .split { grid-template-columns: 1fr; } }
.split > * { max-width: none; }
.split p { max-width: var(--measure); }`
          : `@media (min-width: 58rem) { .split { grid-template-columns: 0.85fr 1.15fr; } }`;

  const align =
    composition.sectionAlign === 'centred'
      ? `.section > .wrap > h2, .section > .wrap > .eyebrow, .section > .wrap > .lede { text-align: center; margin-inline: auto; }
.section > .wrap > .lede { max-width: 46rem; }`
      : composition.sectionAlign === 'alternating'
        ? `.section--flip .split { direction: rtl; }
.section--flip .split > * { direction: ltr; }`
        : '/* Sections are set from the left. */';

  /**
   * What the accent is spent on.
   *
   * One accent used in one place reads as a decision. The same accent on the
   * buttons and the headings and the rules and the eyebrows reads as a theme
   * picker, which is the look this whole change exists to get away from.
   */
  const accent =
    composition.accentUse === 'headings'
      ? `h2 { color: var(--accent); }
.btn { background: var(--text); }`
      : composition.accentUse === 'rules'
        ? `.section + .section { border-top-color: var(--accent); }
.eyebrow::after { content: ''; display: block; width: 2.5rem; height: 2px; background: var(--accent); margin-top: 0.75rem; }
.btn { background: var(--text); }`
        : composition.accentUse === 'blocks'
          ? `.section--tint { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
.card { border-left: 3px solid var(--accent); }
.btn { background: var(--accent); }`
          : `.btn { background: var(--accent); }`;

  const nav =
    composition.navStyle === 'plain'
      ? `.site-head { border-bottom: 0; }`
      : composition.navStyle === 'underline'
        ? `.site-head { border-bottom: 0; }
.site-nav a { padding-bottom: 0.2rem; border-bottom: 1px solid transparent; }
.site-nav a:hover { border-bottom-color: var(--accent); }`
        : `.site-head { border-bottom: 1px solid var(--line); }`;

  const lede =
    composition.ledeColour === 'text'
      ? `.lede { color: var(--text); }`
      : `.lede { color: var(--muted); }`;

  return [rhythm, eyebrow, headingCase, card, columns, gallery, intro, align, accent, nav, lede].join(
    '\n',
  );
}

/**
 * The stylesheet for one demo.
 *
 * `spec` is what decides how it looks. It is optional only so that a caller
 * holding just a brief — an export, a test — still gets the page that brief
 * implies; `styleFromBrief` is the kit-only pass and reproduces exactly what
 * this used to emit.
 */
export function renderStylesheet(brief: Brief, spec: StyleSpec = styleFromBrief(brief)): string {
  /**
   * Follow the palette rather than assuming light.
   *
   * A palette measured off a dark reference site puts a near-black ground on
   * the page, and declaring `light` alongside it hands the reader light
   * scrollbars and light form controls around a dark page. It was safe to
   * hardcode while every demo used the built-in cream; it is not now.
   */
  const ground = spec.palette.find((colour) => colour.role === 'background')?.value ?? '#ffffff';
  const parsed = parseColour(ground);
  const scheme = parsed && luminance(parsed) < 0.45 ? 'dark' : 'light';

  return `/* Generated for a demo. One file, no build step. */

:root {
${paletteBlock(spec.palette)}
    --display: ${cssSafe(fontStackFrom(spec.typography, 'display'))};
    --body: ${cssSafe(fontStackFrom(spec.typography, 'body'))};
${styleVars(spec)}
    color-scheme: ${scheme};
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }

@media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--body);
    font-size: var(--body-size);
    line-height: var(--body-leading);
    -webkit-font-smoothing: antialiased;
}

img { max-width: 100%; height: auto; display: block; }

a { color: inherit; }

h1, h2, h3 {
    font-family: var(--display);
    font-weight: var(--display-weight);
    line-height: var(--display-leading);
    letter-spacing: var(--display-tracking);
    text-wrap: balance;
    margin: 0;
}

h1 { font-size: var(--h1); }
h2 { font-size: var(--h2); }
h3 { font-size: var(--h3); line-height: 1.25; }

p { margin: 0 0 1em; max-width: var(--measure); text-wrap: pretty; }
p:last-child { margin-bottom: 0; }

.wrap { width: 100%; max-width: var(--measure-page); margin-inline: auto; padding-inline: var(--gutter); }

.section { padding-block: var(--section-gap); }
.eyebrow {
    color: var(--accent);
    margin: 0 0 1rem;
}

.lede { font-size: var(--lede); color: var(--muted); line-height: 1.5; }

/* Skip link — the first thing a keyboard reaches. */
.skip {
    position: absolute;
    left: -9999px;
    top: 0;
    background: var(--accent);
    color: #fff;
    padding: 0.75rem 1.25rem;
    z-index: 100;
}
.skip:focus { left: 0; }

:where(a, button, summary):focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 2px;
}

/* -- Header ----------------------------------------------------- */

.site-head {
    position: sticky;
    top: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
}
.site-head__inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    min-height: 4.25rem;
}
.wordmark {
    font-family: var(--display);
    font-weight: 600;
    font-size: 1.1rem;
    letter-spacing: -0.01em;
    text-decoration: none;
}
.site-nav { display: flex; gap: 1.5rem; align-items: center; }
.site-nav a { text-decoration: none; color: var(--muted); font-size: 0.95rem; }
.site-nav a:hover { color: var(--text); }
@media (max-width: 46rem) { .site-nav { display: none; } }

/* -- Buttons ---------------------------------------------------- */

.btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.85rem 1.6rem;
    border-radius: var(--radius-button);
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    font-weight: 550;
    font-size: 0.98rem;
    border: 1px solid transparent;
    transition: transform 0.15s ease, filter 0.15s ease;
}
.btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
.btn--ghost { background: transparent; color: var(--text); border-color: var(--line); }

/* -- Media frames ------------------------------------------------ */

.frame {
    border-radius: var(--frame);
    overflow: hidden;
    background: var(--surface);
}
.frame img { width: 100%; height: 100%; object-fit: cover; }

/**
 * The mark on a picture we generated rather than found.
 *
 * Small, but never hidden: this is a concept for a business that has not seen
 * it, and a reader is entitled to know which photographs are theirs.
 */
.frame { position: relative; }
.frame__made {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    background: color-mix(in srgb, var(--text) 78%, transparent);
    color: var(--bg);
    font-family: var(--body);
    font-size: 0.65rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
}

/* -- Hero ------------------------------------------------------- */

.hero { padding-block: clamp(4rem, 10vw, 8.5rem) var(--section-gap); }
.hero__grid { display: grid; gap: clamp(2.5rem, 6vw, 4.5rem); align-items: center; }
@media (min-width: 60rem) { .hero__grid--split { grid-template-columns: 1.05fr 0.95fr; } }
.hero p.lede { margin-top: 1.5rem; }
.hero__actions { display: flex; flex-wrap: wrap; gap: 0.85rem; margin-top: 2.25rem; }
.hero__media { --frame-width: 32rem; aspect-ratio: 4 / 3; }

/* Stacked: the headline reads first, full width, then one wide picture. */
.hero--stacked .hero__copy { max-width: 46rem; }
.hero--stacked .hero__media { --frame-width: 76rem; aspect-ratio: 21 / 9; margin-top: clamp(2.5rem, 6vw, 4rem); }

/**
 * Editorial: an oversized headline across the full measure, with the copy
 * set into the second column beneath it.
 *
 * The offset is the point of the treatment. Left-aligning the copy under the
 * headline would give the same result as the stacked treatment and leave
 * half the row empty, which is how an intentional layout starts looking
 * like a broken one.
 */
.hero--editorial .hero__lead { display: grid; gap: clamp(1.5rem, 4vw, 3rem); }
@media (min-width: 60rem) {
    .hero--editorial .hero__lead { grid-template-columns: 1fr 1fr; align-items: start; }
    .hero--editorial h1 { grid-column: 1 / -1; }
    .hero--editorial .hero__aside { grid-column: 2; }
}
.hero--editorial .hero__media { --frame-width: 76rem; aspect-ratio: 16 / 7; margin-top: clamp(2rem, 5vw, 3.5rem); }

/* Full-bleed: the picture is the page, the type sits on a scrim. */
.hero--bleed { position: relative; padding-block: clamp(6rem, 18vw, 12rem); color: #fff; isolation: isolate; }
.hero--bleed .hero__bg { position: absolute; inset: 0; z-index: -2; overflow: hidden; }
.hero--bleed .hero__bg img { width: 100%; height: 100%; object-fit: cover; }
.hero--bleed::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(180deg, color-mix(in srgb, #000 25%, transparent), color-mix(in srgb, #000 70%, transparent));
}
.hero--bleed .eyebrow { color: #fff; opacity: 0.85; }
.hero--bleed .lede { color: rgba(255, 255, 255, 0.88); }
.hero--bleed .hero__copy { max-width: 44rem; }
.hero--bleed .btn--ghost { color: #fff; border-color: rgba(255, 255, 255, 0.5); }
.hero--bleed .frame__made { right: var(--gutter); }

/* -- Cards ------------------------------------------------------ *
 * The columns and the card's own fill and border come from the spec's
 * composition, appended at the end of this file. Only the shared structure
 * is here — anything decided per demo must be absent rather than overridden,
 * or a choice of two columns still inherits three.                          */

.cards { display: grid; gap: 1.5rem; margin-top: 3rem; }

.card {
    border-radius: var(--radius-card);
    padding: var(--card-pad);
}
.card h3 { margin-bottom: 0.6rem; }
.card p { color: var(--muted); }

/* -- Gallery ---------------------------------------------------- *
 * The pattern — even grid, mosaic lead, filmstrip, stagger — comes from the
 * spec.                                                                     */

.gallery { display: grid; gap: 1rem; margin-top: 3rem; }
.gallery .frame { --frame-width: 24rem; margin: 0; }

/* -- Quotes ----------------------------------------------------- */

.quote {
    font-family: var(--display);
    font-size: clamp(1.25rem, 1.05rem + 0.9vw, 1.75rem);
    line-height: 1.35;
    margin: 0;
    max-width: 46ch;
}
.quote cite { display: block; margin-top: 1.25rem; font-family: var(--body); font-size: 0.95rem; font-style: normal; color: var(--muted); }

/* -- Split ------------------------------------------------------ *
 * How the column divides comes from the spec's introLayout.                */

.split { display: grid; gap: clamp(2rem, 5vw, 4rem); }

/* A split that carries a picture wants even columns, not a narrow rail. */
.split--media { align-items: center; }
@media (min-width: 58rem) { .split--media { grid-template-columns: 1fr 1fr; } }
.split--media .frame { --frame-width: 34rem; aspect-ratio: 5 / 4; }

/* -- Detail list ------------------------------------------------ */

.details { list-style: none; margin: 2rem 0 0; padding: 0; display: grid; gap: 0.85rem; }
.details li { display: flex; gap: 1rem; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 0.85rem; }
.details dt, .details .label { color: var(--muted); font-size: 0.9rem; min-width: 7rem; }
.details a { text-decoration-thickness: 1px; text-underline-offset: 3px; }

/* -- Footer ----------------------------------------------------- */

.site-foot { border-top: 1px solid var(--line); padding-block: 3rem; color: var(--muted); font-size: 0.9rem; }
.site-foot__inner { display: flex; flex-wrap: wrap; gap: 1.5rem; justify-content: space-between; align-items: center; }
.site-foot a { text-decoration: none; }
.site-foot a:hover { text-decoration: underline; }

/* -- The demo ribbon -------------------------------------------- */

.demo-note {
    background: var(--text);
    color: var(--bg);
    font-size: 0.85rem;
    padding: 0.75rem var(--gutter);
    text-align: center;
    line-height: 1.5;
}
.demo-note a { color: inherit; text-underline-offset: 3px; }

/* -- Composition ------------------------------------------------- *
 * Appended last so a spec's choices override the foundation above.  */

${compositionCss(spec)}
`;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/** The pictures assigned to one section, in order. */
function imagesFor(context: DemoContext, sectionId: string): DemoPageImage[] {
  return context.images.filter((image) => image.sectionId === sectionId);
}

/**
 * One picture in a frame.
 *
 * `eager` for the hero and lazy everywhere else: the hero is the largest
 * contentful paint and lazy-loading it is the one place the attribute makes a
 * page measurably worse.
 */
function frameHtml(image: DemoPageImage, eager = false, className = 'frame'): string {
  const alt = image.alt ? escape(image.alt) : '';
  const made = image.generated
    ? '\n          <span class="frame__made">Indicative image</span>'
    : '';

  return `<div class="${className}">
          <img src="${escape(image.src)}" alt="${alt}" loading="${eager ? 'eager' : 'lazy'}" ${
            eager ? 'fetchpriority="high"' : 'decoding="async"'
          } />${made}
        </div>`;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/**
 * Would this section render as anything more than a heading?
 *
 * A band containing one heading and nothing else is the clearest possible
 * signal that a page was generated and not finished — the "What We Offer"
 * with no offers under it. The plan is asked not to produce them; this is
 * what guarantees one never reaches the page, whatever came back.
 *
 * The hero always stays: it carries the name and the call to action even when
 * the model gave it nothing else. Contact stays whenever there is a detail to
 * put in it, which comes from the prospect record rather than the plan.
 */
export function sectionHasSubstance(section: PlanSection, context: DemoContext): boolean {
  if (section.type === 'hero') return true;

  if (section.type === 'contact' || section.type === 'location') {
    return Boolean(
      section.body.trim() ||
        context.contact.email ||
        context.contact.phone ||
        context.contact.address ||
        context.openingHours.length,
    );
  }

  if (section.items.length > 0) return true;
  if (section.body.trim()) return true;
  if (imagesFor(context, section.id).length > 0) return true;

  // A gallery draws on whatever the page has, not only on what was assigned.
  if (section.type === 'gallery' && context.images.length > 0) return true;

  return false;
}

function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escape(part)}</p>`)
    .join('\n          ');
}

function ctaHtml(section: PlanSection, className = 'btn'): string {
  if (!section.cta) return '';
  return `<a class="${className}" href="${escape(section.cta.href)}">${escape(section.cta.label)}</a>`;
}

function heroCopy(section: PlanSection, context: DemoContext): string {
  return `${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
            <h1>${escape(section.heading || context.businessName)}</h1>
            ${section.body ? `<p class="lede">${escape(section.body)}</p>` : ''}
            <div class="hero__actions">
              ${ctaHtml(section)}
              ${context.contact.phone ? `<a class="btn btn--ghost" href="tel:${escape(context.contact.phone.replace(/\s/g, ''))}">${escape(context.contact.phone)}</a>` : ''}
            </div>`;
}

function renderHero(section: PlanSection, context: DemoContext, spec: StyleSpec): string {
  const tokens = spec.tokens;
  const image = imagesFor(context, section.id)[0] ?? context.images[0];
  const open = `    <section class="section hero`;
  const id = `" id="${escape(section.id)}">`;

  // Without a picture, the treatments that exist to frame one are not
  // available. Falling back to `stacked` keeps the type composition rather
  // than leaving an empty column where the image should have been.
  const treatment = image ? tokens.hero : 'stacked';

  if (treatment === 'full-bleed' && image) {
    return `${open} hero--bleed${id}
      <div class="hero__bg">
        <img src="${escape(image.src)}" alt="${escape(image.alt)}" loading="eager" fetchpriority="high" />
        ${image.generated ? '<span class="frame__made">Indicative image</span>' : ''}
      </div>
      <div class="wrap">
        <div class="hero__copy">
            ${heroCopy(section, context)}
        </div>
      </div>
    </section>`;
  }

  if (treatment === 'editorial') {
    return `${open} hero--editorial${id}
      <div class="wrap">
        <div class="hero__lead">
          ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
          <h1>${escape(section.heading || context.businessName)}</h1>
          <div class="hero__aside">
            ${section.body ? `<p class="lede">${escape(section.body)}</p>` : ''}
            <div class="hero__actions">
              ${ctaHtml(section)}
              ${context.contact.phone ? `<a class="btn btn--ghost" href="tel:${escape(context.contact.phone.replace(/\s/g, ''))}">${escape(context.contact.phone)}</a>` : ''}
            </div>
          </div>
        </div>
        ${image ? frameHtml(image, true, 'frame hero__media') : ''}
      </div>
    </section>`;
  }

  if (treatment === 'stacked') {
    return `${open} hero--stacked${id}
      <div class="wrap">
        <div class="hero__copy">
            ${heroCopy(section, context)}
        </div>
        ${image ? frameHtml(image, true, 'frame hero__media') : ''}
      </div>
    </section>`;
  }

  return `${open} hero--split${id}
      <div class="wrap">
        <div class="hero__grid hero__grid--split">
          <div class="hero__copy">
            ${heroCopy(section, context)}
          </div>
          ${image ? frameHtml(image, true, 'frame hero__media') : ''}
        </div>
      </div>
    </section>`;
}

function renderIntro(section: PlanSection, context: DemoContext, tint: boolean): string {
  const image = imagesFor(context, section.id)[0];

  // With a picture this becomes a two-column section rather than a heading
  // beside a paragraph, which is the layout that made text-only sections look
  // like an unfinished template.
  if (image) {
    return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap split split--media">
        <div>
          ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
          <h2>${escape(section.heading)}</h2>
          <div style="margin-top:1.5rem">
          ${paragraphs(section.body)}
          </div>
          ${section.cta ? `<p style="margin-top:2rem">${ctaHtml(section)}</p>` : ''}
        </div>
        ${frameHtml(image)}
      </div>
    </section>`;
  }

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap split">
        <div>
          ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
          <h2>${escape(section.heading)}</h2>
        </div>
        <div>
          ${paragraphs(section.body)}
          ${section.cta ? `<p style="margin-top:2rem">${ctaHtml(section)}</p>` : ''}
        </div>
      </div>
    </section>`;
}

function renderCards(section: PlanSection, tint: boolean): string {
  const cards = section.items
    .map(
      (item) => `          <article class="card">
            <h3>${escape(item.title)}</h3>
            ${item.body ? `<p>${escape(item.body)}</p>` : ''}
          </article>`,
    )
    .join('\n');

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap">
        ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
        <h2>${escape(section.heading)}</h2>
        ${section.body ? `<p class="lede" style="margin-top:1.25rem">${escape(section.body)}</p>` : ''}
        <div class="cards">
${cards}
        </div>
        ${section.cta ? `<p style="margin-top:2.5rem">${ctaHtml(section)}</p>` : ''}
      </div>
    </section>`;
}

function renderGallery(section: PlanSection, context: DemoContext, tint: boolean): string {
  // Its own pictures first; anything left over from the page otherwise, so a
  // gallery is never emptier than the crawl was.
  const assigned = imagesFor(context, section.id);
  const images = (assigned.length ? assigned : context.images.filter((i) => i.role !== 'hero')).slice(0, 6);

  if (images.length === 0) return renderIntro(section, context, tint);

  const figures = images.map((image) => `          ${frameHtml(image)}`).join('\n');

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap">
        ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
        <h2>${escape(section.heading)}</h2>
        ${section.body ? `<p class="lede" style="margin-top:1.25rem">${escape(section.body)}</p>` : ''}
        <div class="gallery">
${figures}
        </div>
      </div>
    </section>`;
}

function renderQuotes(section: PlanSection, tint: boolean): string {
  const quotes = section.items
    .map(
      (item) => `          <blockquote class="quote">
            ${escape(item.body)}
            ${item.title ? `<cite>${escape(item.title)}</cite>` : ''}
          </blockquote>`,
    )
    .join('\n');

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap">
        ${section.heading ? `<h2 style="margin-bottom:2.5rem">${escape(section.heading)}</h2>` : ''}
        <div class="cards">
${quotes}
        </div>
      </div>
    </section>`;
}

/**
 * When they are open and where, as a thing to read rather than a form row.
 *
 * `location` used to render through `renderContact`, which meant a plan
 * carrying both — and the plan prompt encourages both — put the same phone
 * number and address on the page twice, in two identical panels. It also
 * dropped the opening hours: the planner writes a day per item, and nothing
 * looked at `items`. A section headed "Where and when" that answers neither
 * is worse than not having one.
 */
function renderLocation(section: PlanSection, context: DemoContext, tint: boolean): string {
  const hours = openingHours(section, context);
  const address = section.subheading || context.contact.address;
  /**
   * The imagery stage allocates a picture to a location section — a shopfront
   * from the street is one of the few frames a business always has — and the
   * renderer used to drop it on the floor. That is a photograph paid for,
   * stored, and never shown.
   */
  const image = imagesFor(context, section.id)[0];

  const rows = hours.map((entry) => {
    // "Monday: 7am – 3pm" reads as two columns; anything else is one line.
    const [day, ...rest] = entry.split(/:\s(.+)/);
    const when = rest.join('').trim();
    return when
      ? `          <li><span class="label">${escape(day!.trim())}</span> <span>${escape(when)}</span></li>`
      : `          <li><span>${escape(entry)}</span></li>`;
  });

  const details = `<ul class="details">
${rows.join('\n') || `          <li><span>${escape(address || 'Address to come.')}</span></li>`}
          </ul>`;

  const heading = `          ${address ? `<p class="eyebrow">${escape(address)}</p>` : ''}
          <h2>${escape(section.heading || 'Where to find us')}</h2>
          ${section.body ? `<p class="lede" style="margin-top:1.25rem">${escape(section.body)}</p>` : ''}`;

  const cta = section.cta ? `<p style="margin-top:2rem">${ctaHtml(section)}</p>` : '';

  /**
   * With a picture the hours belong under the heading and the photograph
   * takes the second column. Without one they stay in the second column —
   * putting them under the heading instead would leave half the row empty,
   * which is how an intentional layout starts looking like a broken one.
   */
  const body = image
    ? `        <div>
${heading}
          <div style="margin-top:1.75rem">${details}</div>
          ${cta}
        </div>
        ${frameHtml(image)}`
    : `        <div>
${heading}
          ${cta}
        </div>
        <div>
          ${details}
        </div>`;

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap split${image ? ' split--media' : ''}">
${body}
      </div>
    </section>`;
}

/**
 * The opening hours for a section: what the plan wrote, or what research
 * found, never both.
 *
 * The planner puts a day per item; the research stage puts the same list on
 * the context. Concatenating them would print every day twice.
 */
function openingHours(section: PlanSection, context: DemoContext): string[] {
  const fromPlan = section.items
    .map((item) => [item.title, item.body].filter(Boolean).join(' ').trim())
    .filter(Boolean);

  return (fromPlan.length ? fromPlan : context.openingHours).slice(0, 7);
}

function renderContact(
  section: PlanSection,
  context: DemoContext,
  tint: boolean,
  /** True when a location section above has already given the address and hours. */
  locatedAlready = false,
): string {
  const rows: string[] = [];

  if (context.contact.email) {
    rows.push(
      `          <li><span class="label">Email</span> <a href="mailto:${escape(context.contact.email)}">${escape(context.contact.email)}</a></li>`,
    );
  }
  if (context.contact.phone) {
    rows.push(
      `          <li><span class="label">Phone</span> <a href="tel:${escape(context.contact.phone.replace(/\s/g, ''))}">${escape(context.contact.phone)}</a></li>`,
    );
  }
  // Not repeated when the page already has a location section: the same
  // address and the same seven lines of hours in two panels is how a page
  // that has little to say looks like it is padding.
  if (context.contact.address && !locatedAlready) {
    rows.push(`          <li><span class="label">Find us</span> <span>${escape(context.contact.address)}</span></li>`);
  }
  if (!locatedAlready) {
    for (const hours of openingHours(section, context)) {
      rows.push(`          <li><span class="label">Hours</span> <span>${escape(hours)}</span></li>`);
    }
  }

  return `    <section class="section${tint ? ' section--tint' : ''}" id="${escape(section.id)}">
      <div class="wrap split">
        <div>
          ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
          <h2>${escape(section.heading || 'Get in touch')}</h2>
          ${section.body ? `<p class="lede" style="margin-top:1.25rem">${escape(section.body)}</p>` : ''}
          ${section.cta ? `<p style="margin-top:2rem">${ctaHtml(section)}</p>` : ''}
        </div>
        <div>
          <ul class="details">
${rows.join('\n') || '          <li><span>Contact details to come.</span></li>'}
          </ul>
        </div>
      </div>
    </section>`;
}

function renderSection(
  section: PlanSection,
  context: DemoContext,
  index: number,
  spec: StyleSpec,
  page: { hasLocation: boolean } = { hasLocation: false },
): string {
  const tokens = spec.tokens;

  // Tinting is only a separation device under the `tint` rhythm; under the
  // others the stylesheet does not define the class and it would do nothing.
  const tint = tokens.rhythm === 'tint' && index % 2 === 1;

  /**
   * Under `alternating`, every second two-column section is flipped, so a
   * page does not read as the same left-rail repeated down the screen. It is
   * a class rather than a separate renderer because the markup is identical —
   * only the direction of the grid changes.
   */
  const flip = spec.composition.sectionAlign === 'alternating' && index % 2 === 0;

  const rendered = ((): string => {
    switch (section.type) {
      case 'hero':
        return renderHero(section, context, spec);
      case 'services':
      case 'process':
      case 'stats':
        return section.items.length
          ? renderCards(section, tint)
          : renderIntro(section, context, tint);
      case 'gallery':
        return renderGallery(section, context, tint);
      case 'testimonials':
        return section.items.length ? renderQuotes(section, tint) : renderIntro(section, context, tint);
      case 'location':
        return renderLocation(section, context, tint);
      case 'contact':
        return renderContact(section, context, tint, page.hasLocation);
      case 'cta':
        return renderIntro(section, context, true);
      default:
        return section.items.length ? renderCards(section, tint) : renderIntro(section, context, tint);
    }
  })();

  return flip && section.type !== 'hero'
    ? rendered.replace('<section class="section', '<section class="section section--flip')
    : rendered;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/**
 * The ribbon at the top of every generated demo.
 *
 * This is a site built for a business that has not asked for it and has not
 * seen it. It says so, in their own browser, before they read a word of the
 * copy — anything less would be passing off an unsolicited mockup as
 * something they commissioned.
 *
 * When any of the photography is ours rather than theirs, it says that too.
 * The pictures are the part of a concept most likely to be mistaken for a
 * record of the real place.
 */
function demoRibbon(context: DemoContext): string {
  const generated = context.images.some((image) => image.generated);

  return `    <div class="demo-note">
      An unsolicited concept for ${escape(context.businessName)}, designed by
      <a href="${escape(context.designerUrl)}">${escape(context.designerName)}</a>.
      Not affiliated with or endorsed by ${escape(context.businessName)} — no claim here has been
      checked with them, and it can be taken down on request.${
        generated
          ? `\n      Images marked “indicative” were generated for this concept and are not
      ${escape(context.businessName)}'s own photography.`
          : ''
      }
    </div>`;
}

export function renderDemoPage(
  plan: DesignPlanDraft,
  brief: Brief,
  context: DemoContext,
  spec: StyleSpec = styleFromBrief(brief),
): string {
  // Filtered once, so the nav cannot point at a section that was dropped.
  const sections = plan.sections.filter((section) => sectionHasSubstance(section, context));

  const navTargets = sections
    .filter((section) => section.type !== 'hero' && section.heading)
    .slice(0, 4);

  const fonts = fontLinksFrom(spec.typography)
    .map((href) => `    <link rel="stylesheet" href="${escape(href)}" />`)
    .join('\n');

  const page = { hasLocation: sections.some((section) => section.type === 'location') };
  const body = sections
    .map((section, index) => renderSection(section, context, index, spec, page))
    .join('\n\n');

  const year = new Date().getUTCFullYear();

  return `<!doctype html>
<html lang="en-NZ">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(plan.meta.title)}</title>
    <meta name="description" content="${escape(plan.meta.description)}" />
    <!-- A concept built without the business's involvement: keep it out of search. -->
    <meta name="robots" content="noindex, nofollow" />
    <meta property="og:title" content="${escape(plan.meta.title)}" />
    <meta property="og:description" content="${escape(plan.meta.description)}" />
    <meta property="og:type" content="website" />
${fonts ? `    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n${fonts}` : ''}
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
${demoRibbon(context)}

    <header class="site-head">
      <div class="wrap site-head__inner">
        <a class="wordmark" href="#top">${escape(context.businessName)}</a>
        <nav class="site-nav" aria-label="Sections">
${navTargets.map((section) => `          <a href="#${escape(section.id)}">${escape(section.heading.slice(0, 28))}</a>`).join('\n')}
        </nav>
      </div>
    </header>

    <main id="main">
${body}
    </main>

    <footer class="site-foot">
      <div class="wrap site-foot__inner">
        <p>© ${year} ${escape(context.businessName)}</p>
        <p>
${context.socials.map((social) => `          <a href="${escape(social.url)}" rel="noopener noreferrer nofollow">${escape(social.platform)}</a>`).join('\n')}
        </p>
        <p>Concept by <a href="${escape(context.designerUrl)}">${escape(context.designerName)}</a></p>
      </div>
    </footer>
  </body>
</html>
`;
}

export function renderDemoFiles(
  plan: DesignPlanDraft,
  brief: Brief,
  context: DemoContext,
  spec: StyleSpec = styleFromBrief(brief),
): GeneratedFile[] {
  return [
    {
      path: 'index.html',
      content: renderDemoPage(plan, brief, context, spec),
      contentType: 'text/html; charset=utf-8',
    },
    {
      path: 'styles.css',
      content: renderStylesheet(brief, spec),
      contentType: 'text/css; charset=utf-8',
    },
    {
      path: 'robots.txt',
      content: 'User-agent: *\nDisallow: /\n',
      contentType: 'text/plain; charset=utf-8',
    },
  ];
}
