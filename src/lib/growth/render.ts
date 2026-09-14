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
 * the same proportions whatever kit produced it. The stylesheet below is
 * therefore a function of `brief.tokens`: the kit chooses the hero treatment,
 * the density, the type scale, the shapes and how sections are separated, and
 * two kits produce pages that do not look like each other.
 *
 * Output is a single self-contained HTML file plus its stylesheet: no build
 * step, no framework, no JavaScript at all.
 */

import type { Brief, DesignTokens } from './brief';
import { fontLinks, fontStack } from './brief';
import type { DesignPlanDraft, PlanSection } from './qualify';

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
/* Design tokens as CSS                                                */
/* ------------------------------------------------------------------ */

/** Section rhythm and gutters. */
const DENSITY: Record<DesignTokens['density'], { section: string; gutter: string; card: string }> = {
  tight: {
    section: 'clamp(2.5rem, 6vw, 4.5rem)',
    gutter: 'clamp(1rem, 4vw, 2.5rem)',
    card: 'clamp(1.15rem, 2vw, 1.6rem)',
  },
  regular: {
    section: 'clamp(3.5rem, 9vw, 7rem)',
    gutter: 'clamp(1.25rem, 5vw, 4rem)',
    card: 'clamp(1.5rem, 3vw, 2.25rem)',
  },
  airy: {
    section: 'clamp(5rem, 12vw, 10rem)',
    gutter: 'clamp(1.5rem, 6vw, 5.5rem)',
    card: 'clamp(2rem, 4vw, 3rem)',
  },
};

/** How far display type is pushed against the body text. */
const TYPE_SCALE: Record<
  DesignTokens['typeScale'],
  { h1: string; h2: string; h3: string; lede: string; tracking: string; leading: string }
> = {
  restrained: {
    h1: 'clamp(2rem, 1.5rem + 2.2vw, 3.25rem)',
    h2: 'clamp(1.5rem, 1.25rem + 1.2vw, 2.1rem)',
    h3: 'clamp(1.05rem, 1rem + 0.35vw, 1.25rem)',
    lede: 'clamp(1.05rem, 1rem + 0.3vw, 1.2rem)',
    tracking: '-0.01em',
    leading: '1.2',
  },
  balanced: {
    h1: 'clamp(2.5rem, 1.6rem + 4.2vw, 5rem)',
    h2: 'clamp(1.85rem, 1.3rem + 2.2vw, 3rem)',
    h3: 'clamp(1.15rem, 1rem + 0.6vw, 1.4rem)',
    lede: 'clamp(1.1rem, 1rem + 0.5vw, 1.35rem)',
    tracking: '-0.02em',
    leading: '1.08',
  },
  dramatic: {
    h1: 'clamp(3rem, 1.5rem + 6.8vw, 7.5rem)',
    h2: 'clamp(2.2rem, 1.4rem + 3.4vw, 4rem)',
    h3: 'clamp(1.25rem, 1.05rem + 0.8vw, 1.65rem)',
    lede: 'clamp(1.2rem, 1rem + 0.8vw, 1.6rem)',
    tracking: '-0.035em',
    leading: '0.98',
  },
};

const RADIUS: Record<DesignTokens['radius'], { card: string; media: string }> = {
  square: { card: '0', media: '0' },
  soft: { card: '1rem', media: '1.25rem' },
  round: { card: '1.75rem', media: '2rem' },
};

const BUTTON_RADIUS: Record<DesignTokens['button'], string> = {
  pill: '999px',
  rounded: '0.625rem',
  square: '0',
};

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

export function tokenCss(tokens: DesignTokens): string {
  const density = DENSITY[tokens.density];
  const type = TYPE_SCALE[tokens.typeScale];

  return [
    `    --gutter: ${density.gutter};`,
    `    --section-gap: ${density.section};`,
    `    --card-pad: ${density.card};`,
    `    --radius-card: ${RADIUS[tokens.radius].card};`,
    `    --radius-media: ${RADIUS[tokens.radius].media};`,
    `    --radius-button: ${BUTTON_RADIUS[tokens.button]};`,
    `    --frame: ${IMAGERY_FRAME[tokens.imagery]};`,
    `    --h1: ${type.h1};`,
    `    --h2: ${type.h2};`,
    `    --h3: ${type.h3};`,
    `    --lede: ${type.lede};`,
    `    --display-tracking: ${type.tracking};`,
    `    --display-leading: ${type.leading};`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Stylesheet                                                          */
/* ------------------------------------------------------------------ */

function paletteBlock(brief: Brief): string {
  const named = new Map(brief.palette.map((c) => [c.role, c.value]));
  const byName = brief.palette.map((c) => `    --${cssSafe(c.name)}: ${cssSafe(c.value)};`).join('\n');

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

  return `${byName}\n${roles}`;
}

export function renderStylesheet(brief: Brief): string {
  const tokens = brief.tokens;

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
      ? `    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;`
      : `    font-size: 0.9rem;
    letter-spacing: 0.01em;
    font-weight: 500;`;

  return `/* Generated for a demo. One file, no build step. */

:root {
${paletteBlock(brief)}
    --display: ${cssSafe(fontStack(brief, 'display'))};
    --body: ${cssSafe(fontStack(brief, 'body'))};
    --measure: 62ch;
${tokenCss(tokens)}
    color-scheme: light;
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
    font-size: clamp(1rem, 0.96rem + 0.2vw, 1.125rem);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
}

img { max-width: 100%; height: auto; display: block; }

a { color: inherit; }

h1, h2, h3 {
    font-family: var(--display);
    font-weight: 600;
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

.wrap { width: 100%; max-width: 76rem; margin-inline: auto; padding-inline: var(--gutter); }

.section { padding-block: var(--section-gap); }
${rhythm}

.eyebrow {
${eyebrow}
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

/* -- Cards ------------------------------------------------------ */

.cards { display: grid; gap: 1.5rem; margin-top: 3rem; }
@media (min-width: 42rem) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 66rem) { .cards--three { grid-template-columns: repeat(3, 1fr); } }

.card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    padding: var(--card-pad);
}
.card h3 { margin-bottom: 0.6rem; }
.card p { color: var(--muted); }

/* -- Gallery ---------------------------------------------------- */

.gallery { display: grid; gap: 1rem; margin-top: 3rem; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 60rem) { .gallery { grid-template-columns: repeat(3, 1fr); } }
.gallery .frame { --frame-width: 24rem; margin: 0; aspect-ratio: 1; }
.gallery .frame:first-child { grid-column: span 2; aspect-ratio: 2; }
@media (min-width: 60rem) { .gallery .frame:first-child { aspect-ratio: 2 / 1; } }

/* -- Quotes ----------------------------------------------------- */

.quote {
    font-family: var(--display);
    font-size: clamp(1.25rem, 1.05rem + 0.9vw, 1.75rem);
    line-height: 1.35;
    margin: 0;
    max-width: 46ch;
}
.quote cite { display: block; margin-top: 1.25rem; font-family: var(--body); font-size: 0.95rem; font-style: normal; color: var(--muted); }

/* -- Split ------------------------------------------------------ */

.split { display: grid; gap: clamp(2rem, 5vw, 4rem); }
@media (min-width: 58rem) { .split { grid-template-columns: 0.85fr 1.15fr; } }

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

function renderHero(section: PlanSection, context: DemoContext, tokens: DesignTokens): string {
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
        <div class="cards${section.items.length % 3 === 0 ? ' cards--three' : ''}">
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

function renderContact(section: PlanSection, context: DemoContext, tint: boolean): string {
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
  if (context.contact.address) {
    rows.push(`          <li><span class="label">Find us</span> <span>${escape(context.contact.address)}</span></li>`);
  }
  for (const hours of context.openingHours.slice(0, 7)) {
    rows.push(`          <li><span class="label">Hours</span> <span>${escape(hours)}</span></li>`);
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
  tokens: DesignTokens,
): string {
  // Tinting is only a separation device under the `tint` rhythm; under the
  // others the stylesheet does not define the class and it would do nothing.
  const tint = tokens.rhythm === 'tint' && index % 2 === 1;

  switch (section.type) {
    case 'hero':
      return renderHero(section, context, tokens);
    case 'services':
    case 'process':
    case 'stats':
      return section.items.length ? renderCards(section, tint) : renderIntro(section, context, tint);
    case 'gallery':
      return renderGallery(section, context, tint);
    case 'testimonials':
      return section.items.length ? renderQuotes(section, tint) : renderIntro(section, context, tint);
    case 'contact':
    case 'location':
      return renderContact(section, context, tint);
    case 'cta':
      return renderIntro(section, context, true);
    default:
      return section.items.length ? renderCards(section, tint) : renderIntro(section, context, tint);
  }
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
): string {
  // Filtered once, so the nav cannot point at a section that was dropped.
  const sections = plan.sections.filter((section) => sectionHasSubstance(section, context));

  const navTargets = sections
    .filter((section) => section.type !== 'hero' && section.heading)
    .slice(0, 4);

  const fonts = fontLinks(brief)
    .map((href) => `    <link rel="stylesheet" href="${escape(href)}" />`)
    .join('\n');

  const body = sections
    .map((section, index) => renderSection(section, context, index, brief.tokens))
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
): GeneratedFile[] {
  return [
    {
      path: 'index.html',
      content: renderDemoPage(plan, brief, context),
      contentType: 'text/html; charset=utf-8',
    },
    {
      path: 'styles.css',
      content: renderStylesheet(brief),
      contentType: 'text/css; charset=utf-8',
    },
    {
      path: 'robots.txt',
      content: 'User-agent: *\nDisallow: /\n',
      contentType: 'text/plain; charset=utf-8',
    },
  ];
}
