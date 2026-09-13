/**
 * How big are they already?
 *
 * The pipeline's original failure mode: a prominent roaster with eleven cafés
 * and an in-house design team scored *well*, because the fit prompt asked
 * "can they plausibly pay for design work" and the answer was obviously yes.
 * Ability to pay is the wrong question. A speculative redesign from a
 * freelancer is a reasonable approach to an owner-operated shop and an
 * imposition on a national brand — they have an agency, a brand guide, and no
 * interest in a stranger's concept.
 *
 * So scale is measured separately from fit and acts as a *ceiling*: above the
 * campaign's threshold a prospect is dropped no matter how good a fit the
 * model believes them to be. Measured rather than judged, because "is this a
 * chain" has real evidence behind it and a model asked to eyeball it will
 * happily decide a familiar name is a plucky local.
 *
 * Every signal here is something the crawl or the directory actually found.
 * Nothing is inferred from the name.
 */

import type { CrawlResult } from './crawl';
import type { DiscoveredBusiness } from './discovery/types';

export interface ScaleSignal {
  id: string;
  label: string;
  weight: number;
  hit: boolean;
  detail?: string;
}

export interface ScaleAssessment {
  /** 0..100. Roughly: 0 one person, 50 established local, 85+ national brand. */
  score: number;
  signals: ScaleSignal[];
  /** Chain name where one was found. */
  brand: string;
  branchCount: number;
  /** Plain-language reason, for the UI and the prompt. */
  summary: string;
  /** True when the evidence is conclusive rather than accumulated. */
  decisive: boolean;
}

/**
 * Markers of an organisation with departments.
 *
 * A careers page means HR. A press page means someone handles press. A
 * wholesale page means accounts. None of these belong to a business that
 * would be pleased to receive a free concept site.
 */
const PAGE_MARKERS: Array<[RegExp, string, number]> = [
  [/\b(careers?|jobs|join-us|work-with-us|vacancies|recruitment)\b/i, 'Careers page', 14],
  [/\b(press|media|newsroom|media-kit|press-kit)\b/i, 'Press or media page', 12],
  [/\b(wholesale|stockists|distributors|trade-enquiries|b2b)\b/i, 'Wholesale or stockists', 10],
  [/\b(franchis\w*)\b/i, 'Franchising', 18],
  [/\b(investors?|corporate|about-the-group|our-company)\b/i, 'Corporate or investor pages', 16],
  [/\b(sustainability|impact-report|csr|esg)\b/i, 'Sustainability reporting', 10],
  [/\b(gift-?cards?|loyalty|rewards|subscriptions?)\b/i, 'Gift cards, loyalty or subscriptions', 7],
  [/\b(our-(stores|locations|cafes|venues|branches)|find-a-store|store-locator|locations)\b/i, 'Store locator', 14],
];

/**
 * Stacks nobody assembles for a single shopfront.
 *
 * A business running Shopify Plus with Klaviyo has someone whose job this is.
 * Plain Shopify or WordPress says nothing either way and is not listed.
 */
const STACK_MARKERS: Array<[RegExp, string, number]> = [
  [/shopify-?plus|plus\.shopify/i, 'Shopify Plus', 16],
  [/klaviyo/i, 'Klaviyo', 8],
  [/(^|\W)(hubspot|marketo|pardot|salesforce)/i, 'Marketing automation', 12],
  [/contentful|sanity\.io|prismic|storyblok|datocms/i, 'A headless CMS', 12],
  [/algolia|elasticsearch|coveo/i, 'Hosted search', 8],
  [/optimizely|vwo\.com|launchdarkly|_ab_test/i, 'A/B testing', 12],
  [/segment\.(com|io)|analytics\.js|mixpanel|amplitude/i, 'Product analytics', 8],
  [/_next\/static|__nuxt|sveltekit|remix-run/i, 'A built application front end', 8],
  [/recaptcha\/enterprise|cloudflare-?turnstile/i, 'Enterprise bot protection', 6],
  [/cdn\.shopify\.com\/.*\/assets\/.*theme/i, 'A bespoke commerce theme', 5],
];

/** "Design by …" in a footer means somebody already has this work. */
const AGENCY_CREDIT =
  /\b(designed?|built|developed|made|crafted|site)\s+(by|with)\s+(?!us\b|me\b|hand\b|love\b|care\b)[A-Z][\w&.' -]{2,40}/;

/** Language a business only uses once it has more than one of something. */
const SCALE_LANGUAGE: Array<[RegExp, string, number]> = [
  [/\bour (stores|shops|cafes|cafés|venues|branches|locations|sites)\b/i, 'Talks about multiple sites', 14],
  [/\b(head office|support office|national|nationwide|australia-wide|new zealand wide)\b/i, 'Operates nationally', 20],
  [/\b(our team of|\d{2,}\s+(staff|employees|people)\b)/i, 'Names a sizeable team', 12],
  [/\b(since 19\d{2})\b/i, 'Trading since before 2000', 6],
  [/\b(award-winning|as (seen|featured) in|winner of)\b/i, 'Claims press or awards', 8],
  [/\b(shipping (worldwide|internationally)|international (delivery|shipping))\b/i, 'Ships internationally', 10],
];

function signal(id: string, label: string, weight: number, hit: boolean, detail?: string): ScaleSignal {
  return { id, label, weight, hit, detail };
}

/**
 * Measure scale from what discovery and the crawl found.
 *
 * `branchCount` comes from the directory: OpenStreetMap maps one point per
 * branch, so counting them in the searched region is the cheapest and most
 * reliable chain detector available, and it needs no API key.
 */
export function assessScale(
  business: Pick<
    DiscoveredBusiness,
    'name' | 'brand' | 'brandWikidata' | 'operator' | 'branchCount' | 'reviewCount'
  >,
  crawl: CrawlResult | null,
): ScaleAssessment {
  const branchCount = Math.max(1, business.branchCount ?? 1);
  const brand = (business.brand ?? '').trim();
  const signals: ScaleSignal[] = [];

  /* -- Evidence that settles it on its own ------------------------ */

  // A Wikidata brand id is assigned to recognised chains. There is no reading
  // of this where the business is a one-shop local.
  const knownBrand = Boolean(business.brandWikidata);
  signals.push(
    signal(
      'known-brand',
      'A recognised chain with its own Wikidata entry',
      60,
      knownBrand,
      business.brandWikidata,
    ),
  );

  signals.push(
    signal(
      'many-branches',
      'Several branches in this region alone',
      branchCount >= 5 ? 45 : branchCount >= 3 ? 30 : branchCount >= 2 ? 16 : 0,
      branchCount >= 2,
      `${branchCount} found`,
    ),
  );

  signals.push(
    signal(
      'branded',
      'Trades under a chain brand',
      12,
      Boolean(brand) && brand.toLowerCase() !== business.name.toLowerCase(),
      brand,
    ),
  );

  signals.push(
    signal(
      'operated',
      'Run by an operator other than itself',
      10,
      Boolean(business.operator) &&
        (business.operator ?? '').toLowerCase() !== business.name.toLowerCase(),
      business.operator,
    ),
  );

  /* -- Evidence from their own site -------------------------------- */

  if (crawl && crawl.reachable) {
    const html = crawl.pages.map((page) => page.html).join('\n');
    const text = crawl.pages.map((page) => page.extracted.text).join('\n');
    const paths = new Set<string>();

    for (const page of crawl.pages) {
      for (const link of page.extracted.links) {
        try {
          paths.add(new URL(link.href, page.finalUrl).pathname.toLowerCase());
        } catch {
          // A link we cannot resolve tells us nothing about their size.
        }
      }
    }
    const allPaths = [...paths].join(' ');

    for (const [pattern, label, weight] of PAGE_MARKERS) {
      signals.push(signal(`page:${label}`, label, weight, pattern.test(allPaths)));
    }

    for (const [pattern, label, weight] of STACK_MARKERS) {
      signals.push(signal(`stack:${label}`, label, weight, pattern.test(html)));
    }

    for (const [pattern, label, weight] of SCALE_LANGUAGE) {
      signals.push(signal(`copy:${label}`, label, weight, pattern.test(text)));
    }

    const footer = text.slice(-1500);
    signals.push(
      signal(
        'agency-credit',
        'Credits an agency in the footer — somebody already has this work',
        22,
        AGENCY_CREDIT.test(footer),
        footer.match(AGENCY_CREDIT)?.[0]?.slice(0, 80),
      ),
    );

    // A large top-level navigation implies a lot to organise.
    const navSize = new Set(
      crawl.pages[0]?.extracted.links
        .map((link) => {
          try {
            return new URL(link.href, crawl.pages[0]!.finalUrl).pathname.split('/')[1] ?? '';
          } catch {
            return '';
          }
        })
        .filter(Boolean) ?? [],
    ).size;
    signals.push(
      signal('big-nav', 'A large site', navSize >= 18 ? 12 : navSize >= 12 ? 7 : 0, navSize >= 12, `${navSize} sections`),
    );

    signals.push(
      signal(
        'multi-region',
        'Offers a country or currency selector',
        14,
        /\b(select (your )?(country|region)|change (country|currency)|\/en-(au|nz|gb|us)\/)/i.test(html),
      ),
    );
  }

  /* -- Directory reach --------------------------------------------- */

  const reviews = business.reviewCount ?? 0;
  signals.push(
    signal(
      'many-reviews',
      'A lot of public reviews',
      reviews >= 2000 ? 26 : reviews >= 800 ? 18 : reviews >= 300 ? 10 : 0,
      reviews >= 300,
      `${reviews} reviews`,
    ),
  );

  const score = Math.max(0, Math.min(100, signals.reduce((sum, s) => sum + (s.hit ? s.weight : 0), 0)));
  const decisive = knownBrand || branchCount >= 3;

  const hits = signals.filter((s) => s.hit && s.weight > 0);
  const summary = knownBrand
    ? `${brand || business.name} is a recognised chain. An unsolicited concept is not the way in here.`
    : branchCount >= 3
      ? `${branchCount} branches in this region alone — this is a group, not a shopfront.`
      : hits.length === 0
        ? 'Looks like a single independent business.'
        : `${hits.length} sign${hits.length === 1 ? '' : 's'} of an established operation: ${hits
            .slice(0, 3)
            .map((s) => s.label.toLowerCase())
            .join('; ')}.`;

  return { score, signals, brand, branchCount, summary, decisive };
}

/** Render for a prompt: hits only, as facts. */
export function renderScale(scale: ScaleAssessment): string {
  const hits = scale.signals.filter((s) => s.hit && s.weight > 0);
  return [
    `scale_score: ${scale.score} (0 is one person, 85+ is a national brand)`,
    scale.brand ? `brand: ${scale.brand}` : '',
    `branches_found: ${scale.branchCount}`,
    hits.length
      ? `size_signals:\n${hits.map((s) => `  - ${s.label}${s.detail ? ` (${s.detail})` : ''}`).join('\n')}`
      : 'size_signals: none — looks independent',
  ]
    .filter(Boolean)
    .join('\n');
}
