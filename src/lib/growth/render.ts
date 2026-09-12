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
 * Output is a single self-contained HTML file plus its stylesheet: no build
 * step, no framework, no JavaScript beyond a few lines for the nav.
 */

import type { Brief } from './brief';
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

export interface DemoContext {
  businessName: string;
  niche: string;
  region: string;
  contact: { email: string; phone: string; address: string };
  socials: Array<{ platform: string; url: string }>;
  /** Public paths of their own photography, in preference order. */
  images: string[];
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
  return `/* Generated for a demo. One file, no build step. */

:root {
${paletteBlock(brief)}
    --display: ${cssSafe(fontStack(brief, 'display'))};
    --body: ${cssSafe(fontStack(brief, 'body'))};
    --measure: 62ch;
    --gutter: clamp(1.25rem, 5vw, 4rem);
    --section-gap: clamp(3.5rem, 9vw, 7rem);
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
    line-height: 1.08;
    letter-spacing: -0.02em;
    text-wrap: balance;
    margin: 0;
}

h1 { font-size: clamp(2.5rem, 1.6rem + 4.2vw, 5rem); }
h2 { font-size: clamp(1.85rem, 1.3rem + 2.2vw, 3rem); }
h3 { font-size: clamp(1.15rem, 1rem + 0.6vw, 1.4rem); }

p { margin: 0 0 1em; max-width: var(--measure); text-wrap: pretty; }
p:last-child { margin-bottom: 0; }

.wrap { width: 100%; max-width: 76rem; margin-inline: auto; padding-inline: var(--gutter); }

.section { padding-block: var(--section-gap); }
.section + .section { border-top: 1px solid var(--line); }
.section--tint { background: var(--surface); }

.eyebrow {
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 600;
    margin: 0 0 1rem;
}

.lede { font-size: clamp(1.1rem, 1rem + 0.5vw, 1.35rem); color: var(--muted); }

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
    border-radius: 999px;
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

/* -- Hero ------------------------------------------------------- */

.hero { padding-block: clamp(4rem, 10vw, 8.5rem) var(--section-gap); }
.hero__grid { display: grid; gap: clamp(2.5rem, 6vw, 4.5rem); align-items: center; }
@media (min-width: 60rem) { .hero__grid--split { grid-template-columns: 1.05fr 0.95fr; } }
.hero p.lede { margin-top: 1.5rem; }
.hero__actions { display: flex; flex-wrap: wrap; gap: 0.85rem; margin-top: 2.25rem; }
.hero__media {
    border-radius: 1.25rem;
    overflow: hidden;
    aspect-ratio: 4 / 3;
    background: var(--surface);
    border: 1px solid var(--line);
}
.hero__media img { width: 100%; height: 100%; object-fit: cover; }

/* -- Cards ------------------------------------------------------ */

.cards { display: grid; gap: 1.5rem; margin-top: 3rem; }
@media (min-width: 42rem) { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 66rem) { .cards--three { grid-template-columns: repeat(3, 1fr); } }

.card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 1rem;
    padding: clamp(1.5rem, 3vw, 2.25rem);
}
.card h3 { margin-bottom: 0.6rem; }
.card p { color: var(--muted); }

/* -- Gallery ---------------------------------------------------- */

.gallery { display: grid; gap: 1rem; margin-top: 3rem; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 60rem) { .gallery { grid-template-columns: repeat(3, 1fr); } }
.gallery figure { margin: 0; border-radius: 0.85rem; overflow: hidden; aspect-ratio: 1; background: var(--surface); }
.gallery img { width: 100%; height: 100%; object-fit: cover; }
.gallery figure:first-child { grid-column: span 2; aspect-ratio: 2; }
@media (min-width: 60rem) { .gallery figure:first-child { aspect-ratio: 2 / 1; } }

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
/* Sections                                                            */
/* ------------------------------------------------------------------ */

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

function renderHero(section: PlanSection, context: DemoContext): string {
  const image = context.images[0];
  const media = image
    ? `
        <div class="hero__media">
          <img src="${escape(image)}" alt="" loading="eager" />
        </div>`
    : '';

  return `    <section class="section hero" id="${escape(section.id)}">
      <div class="wrap">
        <div class="hero__grid${image ? ' hero__grid--split' : ''}">
          <div>
            ${section.subheading ? `<p class="eyebrow">${escape(section.subheading)}</p>` : ''}
            <h1>${escape(section.heading || context.businessName)}</h1>
            ${section.body ? `<p class="lede">${escape(section.body)}</p>` : ''}
            <div class="hero__actions">
              ${ctaHtml(section)}
              ${context.contact.phone ? `<a class="btn btn--ghost" href="tel:${escape(context.contact.phone.replace(/\s/g, ''))}">${escape(context.contact.phone)}</a>` : ''}
            </div>
          </div>${media}
        </div>
      </div>
    </section>`;
}

function renderIntro(section: PlanSection, tint: boolean): string {
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
  const images = context.images.slice(0, 6);
  if (images.length === 0) return renderIntro(section, tint);

  const figures = images
    .map(
      (src) => `          <figure><img src="${escape(src)}" alt="" loading="lazy" /></figure>`,
    )
    .join('\n');

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

function renderSection(section: PlanSection, context: DemoContext, index: number): string {
  const tint = index % 2 === 1;

  switch (section.type) {
    case 'hero':
      return renderHero(section, context);
    case 'services':
    case 'process':
    case 'stats':
      return section.items.length ? renderCards(section, tint) : renderIntro(section, tint);
    case 'gallery':
      return renderGallery(section, context, tint);
    case 'testimonials':
      return section.items.length ? renderQuotes(section, tint) : renderIntro(section, tint);
    case 'contact':
    case 'location':
      return renderContact(section, context, tint);
    case 'cta':
      return renderIntro(section, true);
    default:
      return section.items.length ? renderCards(section, tint) : renderIntro(section, tint);
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
 */
function demoRibbon(context: DemoContext): string {
  return `    <div class="demo-note">
      An unsolicited concept for ${escape(context.businessName)}, designed by
      <a href="${escape(context.designerUrl)}">${escape(context.designerName)}</a>.
      Not affiliated with or endorsed by ${escape(context.businessName)} — no claim here has been
      checked with them, and it can be taken down on request.
    </div>`;
}

export function renderDemoPage(
  plan: DesignPlanDraft,
  brief: Brief,
  context: DemoContext,
): string {
  const navTargets = plan.sections
    .filter((section) => section.type !== 'hero' && section.heading)
    .slice(0, 4);

  const fonts = fontLinks(brief)
    .map((href) => `    <link rel="stylesheet" href="${escape(href)}" />`)
    .join('\n');

  const sections = plan.sections
    .map((section, index) => renderSection(section, context, index))
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
    <link rel="stylesheet" href="/styles.css" />
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
${sections}
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
