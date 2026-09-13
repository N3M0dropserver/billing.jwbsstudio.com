/**
 * Scoring a prospect.
 *
 * Two numbers, deliberately kept apart because they answer different
 * questions and one of them is far more trustworthy than the other:
 *
 *   presenceScore — how bad the state of their customer-facing content is.
 *                   Measured from what the crawler actually found. No model
 *                   involved, so it is reproducible and can be argued with.
 *
 *   fitScore      — whether they would be a good client: able to pay, worth
 *                   the work, a fit for what you do. This one is a judgement
 *                   and comes from the model, which is why it is capped at
 *                   half the weight and always shown with its reasoning.
 *
 * A high presenceScore on its own is not a prospect. A dormant business with
 * no website scores 95 for need and should still not be written to.
 */

import type { CrawlResult } from './crawl';
import type { DiscoveredBusiness } from './discovery/types';

export type ProspectSignal =
  | 'no-website'
  | 'dated-website'
  | 'no-google-presence'
  | 'maps-only'
  | 'poor-mobile'
  | 'thin-content'
  | 'broken-site'
  | 'social-only'
  | 'other';

export interface AuditCheck {
  id: string;
  /** What a person would say about it. */
  label: string;
  /** Points added to the need score. Negative means they are doing fine. */
  weight: number;
  /** True when the problem is present. */
  failed: boolean;
  detail?: string;
}

export interface SiteAudit {
  checks: AuditCheck[];
  presenceScore: number;
  signal: ProspectSignal;
  /** Plain-language summary of the state of things. */
  summary: string;
  /**
   * Verified *problems*, in words that can go in an email unchanged.
   *
   * Strictly problems: an empty list is what tells the later stages there is
   * no honest case to make for this business, and a positive fact padding the
   * list would quietly defeat that check.
   */
  observations: string[];
  /** True and useful, but not a problem. Background, not an opening line. */
  context: string[];
  platform: string | null;
  pagesSeen: number;
  crawledAt: string;
}

/** Site builders and CMSs, by the fingerprints they leave in the markup. */
const PLATFORM_FINGERPRINTS: Array<[RegExp, string, number]> = [
  [/wix\.com|_wixCssImports|wixstatic/i, 'Wix', 6],
  [/squarespace/i, 'Squarespace', 2],
  [/shopify/i, 'Shopify', 0],
  [/wp-content|wp-includes|wordpress/i, 'WordPress', 2],
  [/weebly/i, 'Weebly', 10],
  [/godaddy|websitebuilder\.godaddy/i, 'GoDaddy Website Builder', 12],
  [/joomla/i, 'Joomla', 14],
  [/drupal/i, 'Drupal', 6],
  [/frontpage|_vti_bin|Microsoft Word/i, 'FrontPage or a Word export', 26],
  [/dreamweaver|adobe golive/i, 'Dreamweaver', 22],
  [/webflow/i, 'Webflow', 0],
  [/framer\.(com|website)/i, 'Framer', 0],
  [/\.myshopify\.com/i, 'Shopify', 0],
];

const PARKED_PATTERNS =
  /this domain (is |may be )?for sale|buy this domain|parked (free )?courtesy|under construction|coming soon|website is being (built|updated)|default web page|it works!|welcome to nginx|apache2 (ubuntu|debian) default/i;

/** Fingerprints of markup nobody would write today. */
const LEGACY_MARKUP =
  /<font\b|<center\b|<marquee\b|<blink\b|bgcolor\s*=|<frameset\b|<applet\b|\.swf\b|cellpadding\s*=/i;

function check(
  id: string,
  label: string,
  weight: number,
  failed: boolean,
  detail?: string,
): AuditCheck {
  return { id, label, weight, failed, detail };
}

export function detectPlatform(html: string): { name: string; penalty: number } | null {
  for (const [pattern, name, penalty] of PLATFORM_FINGERPRINTS) {
    if (pattern.test(html)) return { name, penalty };
  }
  return null;
}

/**
 * Audit what the crawl found.
 *
 * `business` supplies what discovery knew, which matters for the cases where
 * there is nothing to crawl at all.
 */
export function auditSite(
  business: Pick<DiscoveredBusiness, 'name' | 'website' | 'mapsUrl' | 'reviewCount'>,
  crawl: CrawlResult | null,
  now: Date = new Date(),
): SiteAudit {
  const crawledAt = now.toISOString();
  const observations: string[] = [];

  /* ---- No site at all ------------------------------------------- */

  if (!business.website) {
    const onSocialOnly = Boolean(crawl?.socials.length);
    return {
      checks: [check('no-website', 'No website found', 95, true)],
      presenceScore: onSocialOnly ? 88 : 95,
      signal: onSocialOnly ? 'social-only' : business.mapsUrl ? 'maps-only' : 'no-website',
      summary: business.mapsUrl
        ? 'Listed on a map with no website of their own. Everything a customer can find about them was written by somebody else.'
        : 'No website and no listing we could find. Nothing for a customer to look at before they walk in.',
      observations: ['No website could be found for this business.'],
      context: onSocialOnly
        ? [`They are on ${(crawl?.socials ?? []).map((social) => social.platform).join(' and ')}.`]
        : [],
      platform: null,
      pagesSeen: 0,
      crawledAt,
    };
  }

  /* ---- A site that does not answer ------------------------------ */

  if (!crawl || !crawl.reachable) {
    return {
      checks: [check('unreachable', 'The site did not respond', 90, true, crawl?.error)],
      presenceScore: 90,
      signal: 'broken-site',
      summary: `${business.website} did not answer when we looked. A domain that is advertised and does not load costs more than having none.`,
      observations: [`${business.website} did not respond${crawl?.error ? ` (${crawl.error})` : ''}.`],
      context: [],
      platform: null,
      pagesSeen: 0,
      crawledAt,
    };
  }

  const home = crawl.pages[0]!;
  const page = home.extracted;
  const allHtml = crawl.pages.map((p) => p.html).join('\n');
  const totalWords = crawl.pages.reduce((sum, p) => sum + p.extracted.wordCount, 0);
  const platform = detectPlatform(allHtml);

  /* ---- Parked or placeholder ------------------------------------ */

  if (PARKED_PATTERNS.test(page.text.slice(0, 2000)) && page.wordCount < 200) {
    return {
      checks: [check('parked', 'The domain shows a placeholder', 88, true)],
      presenceScore: 88,
      signal: 'broken-site',
      summary:
        'The domain resolves to a placeholder or an under-construction page. Somebody bought the name and stopped.',
      observations: [`${crawl.root} currently shows a placeholder page.`],
      context: [],
      platform: platform?.name ?? null,
      pagesSeen: crawl.pages.length,
      crawledAt,
    };
  }

  /* ---- The real audit ------------------------------------------- */

  const year = now.getUTCFullYear();
  const copyrightAge = page.copyrightYear ? year - page.copyrightYear : null;
  const hasContactRoute = crawl.emails.length > 0 || crawl.phones.length > 0 || page.hasForm;
  const bodyImages = crawl.images.length;
  const slowest = Math.max(...crawl.pages.map((p) => p.elapsedMs));

  const checks: AuditCheck[] = [
    check(
      'no-viewport',
      'No mobile viewport — the site is not built for phones',
      20,
      !page.viewport,
    ),
    check('no-https', 'Does not serve over HTTPS', 14, !crawl.httpsWorks),
    check(
      'thin-content',
      'Almost nothing to read',
      16,
      totalWords < 150,
      `${totalWords} words across ${crawl.pages.length} page(s)`,
    ),
    check(
      'single-page',
      'A single page with nowhere to go',
      7,
      // Only a finding when we actually looked for more. The shortlist stage
      // samples one page per prospect; that is our budget, not their site.
      crawl.pagesRequested > 1 && crawl.pages.length <= 1,
    ),
    check('no-h1', 'No first-level heading', 5, !page.headings.some((h) => h.level === 1)),
    check('no-description', 'No meta description for search results', 5, !page.metaDescription),
    check(
      'weak-title',
      'The page title is a placeholder',
      6,
      !page.title || /^(home|untitled|index|new page|document|welcome)\b/i.test(page.title),
      page.title || '(empty)',
    ),
    check(
      'stale-copyright',
      'The copyright line has not been touched in years',
      13,
      copyrightAge !== null && copyrightAge >= 3,
      copyrightAge !== null ? `© ${page.copyrightYear}, ${copyrightAge} years old` : undefined,
    ),
    check(
      'legacy-markup',
      'Markup nobody has written this century',
      22,
      LEGACY_MARKUP.test(allHtml),
    ),
    check(
      'dated-platform',
      platform ? `Built on ${platform.name}` : 'Dated platform',
      platform?.penalty ?? 0,
      Boolean(platform && platform.penalty >= 6),
      platform?.name,
    ),
    check('no-images', 'No photography of their own work', 9, bodyImages === 0),
    check('no-contact', 'No obvious way to get in touch', 12, !hasContactRoute),
    check('no-social', 'No social profiles linked', 4, crawl.socials.length === 0),
    check('no-favicon', 'No favicon', 3, !page.hasFavicon),
    check('slow', 'Slow to respond', 7, slowest > 3500, `${slowest}ms worst case`),
    check(
      'truncated',
      'The page is enormous',
      5,
      crawl.pages.some((p) => p.truncated),
    ),
  ];

  const presenceScore = Math.max(
    0,
    Math.min(100, checks.reduce((sum, c) => sum + (c.failed ? c.weight : 0), 0)),
  );

  /* ---- The one-line signal -------------------------------------- */

  let signal: ProspectSignal = 'other';
  if (LEGACY_MARKUP.test(allHtml) || (copyrightAge !== null && copyrightAge >= 3)) {
    signal = 'dated-website';
  } else if (!page.viewport) {
    signal = 'poor-mobile';
  } else if (totalWords < 150) {
    signal = 'thin-content';
  } else if (platform && platform.penalty >= 10) {
    signal = 'dated-website';
  }

  /* ---- Things true enough to put in an email --------------------- */

  if (!page.viewport) {
    observations.push('The site has no mobile viewport, so it renders desktop-width on a phone.');
  }
  if (copyrightAge !== null && copyrightAge >= 3) {
    observations.push(`The footer still says © ${page.copyrightYear}.`);
  }
  if (!crawl.httpsWorks) {
    observations.push('The site only answers over http, so browsers mark it as not secure.');
  }
  if (totalWords < 150) {
    observations.push(`There are only about ${totalWords} words on the whole site.`);
  }
  if (bodyImages === 0) {
    observations.push('There is no photography of their own work anywhere on the site.');
  }
  if (!hasContactRoute) {
    observations.push('There is no email address, phone number or contact form to be found.');
  }
  if (platform && platform.penalty >= 10) {
    observations.push(`It is built on ${platform.name}.`);
  }
  const context: string[] = [];
  if (crawl.socials.length) {
    // True and worth knowing, but it is not a problem — so it belongs in
    // context rather than in the list an outreach email opens from.
    context.push(`They are active on ${crawl.socials.map((s) => s.platform).join(' and ')}.`);
  }
  if (platform && platform.penalty === 0) {
    // A platform that produces good work is background, not a complaint.
    context.push(`Their site is built on ${platform.name}.`);
  }

  const failing = checks.filter((c) => c.failed);
  const summary = failing.length
    ? `${failing.length} issue${failing.length === 1 ? '' : 's'} found: ${failing
        .slice(0, 3)
        .map((c) => c.label.toLowerCase())
        .join('; ')}${failing.length > 3 ? `, and ${failing.length - 3} more` : ''}.`
    : 'The site is in good shape. There is no honest problem to lead with here.';

  return {
    checks,
    presenceScore,
    signal,
    summary,
    observations,
    context,
    platform: platform?.name ?? null,
    pagesSeen: crawl.pages.length,
    crawledAt,
  };
}

/**
 * The ranking number.
 *
 * Weighted toward the measured half. A model that is enthusiastic about a
 * business cannot push a well-built site to the top of the list, and a
 * business the model flags as a bad client cannot be carried by need alone.
 */
export function combineScores(presenceScore: number, fitScore: number): number {
  return Math.round(presenceScore * 0.55 + fitScore * 0.45);
}

/**
 * Render an audit for a prompt.
 *
 * Facts only, one per line, no adjectives — so the model is reasoning about
 * measurements rather than re-deriving them from prose.
 */
export function renderAudit(audit: SiteAudit): string {
  const failing = audit.checks.filter((c) => c.failed);
  return [
    `presence_score: ${audit.presenceScore} (higher means more need)`,
    `platform: ${audit.platform ?? 'unknown'}`,
    `pages_seen: ${audit.pagesSeen}`,
    failing.length
      ? `problems:\n${failing.map((c) => `  - ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}`
      : 'problems: none found',
    audit.context.length ? `background:\n${audit.context.map((line) => `  - ${line}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
