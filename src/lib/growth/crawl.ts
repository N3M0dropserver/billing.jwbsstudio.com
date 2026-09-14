/**
 * The crawler.
 *
 * Politeness is not decoration here. This fetches strangers' sites at the
 * instruction of an automated pipeline, so it: identifies itself honestly,
 * reads robots.txt and obeys it, takes a handful of pages rather than a
 * whole site, caps what it will download, and gives up quickly. A prospecting
 * tool that behaves like a scraper gets the Worker's egress range blocked and
 * embarrasses the person whose name is on the outreach email.
 *
 * Everything fetched is untrusted. It is stored, measured and quoted to a
 * model inside a fenced block — never executed, never reflected into a page
 * we serve.
 */

import {
  extractPage,
  findSocialLinks,
  type ExtractedImage,
  type ExtractedPage,
  type SocialLink,
} from './html';
import { describeError } from '../errors';

export interface CrawlOptions {
  userAgent: string;
  /** Hard ceiling on pages fetched, including the root. */
  maxPages: number;
  /** Bytes we will read from any single response. */
  maxBytes: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Pause between requests to the same host. */
  politenessMs: number;
}

export const DEFAULT_CRAWL: CrawlOptions = {
  userAgent: 'JWBSStudioGrowth/1.0',
  maxPages: 6,
  maxBytes: 1_500_000,
  timeoutMs: 12_000,
  politenessMs: 800,
};

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  /** Round trip in milliseconds, as a rough responsiveness signal. */
  elapsedMs: number;
  html: string;
  truncated: boolean;
  error?: string;
}

export interface CrawlResult {
  root: string;
  /**
   * How many pages the crawl was allowed to fetch.
   *
   * The audit needs this to tell "a site with one page" from "a crawl that
   * only asked for one" — the shortlist stage samples a single page per
   * prospect, and without this every prospect would be flagged as having
   * nowhere to go.
   */
  pagesRequested: number;
  /** Whether anything at all answered. */
  reachable: boolean;
  /** Set when the site only answers over http. */
  httpsWorks: boolean;
  robotsFound: boolean;
  /** Paths robots.txt told us not to touch, that we therefore did not. */
  disallowed: string[];
  pages: Array<FetchedPage & { extracted: ExtractedPage }>;
  socials: SocialLink[];
  emails: string[];
  phones: string[];
  /** Image URLs worth keeping, most promising first. */
  images: string[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

export interface RobotsRules {
  /** Longest-match wins, as the de-facto standard has it. */
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelayMs: number | null;
}

/**
 * Parse robots.txt for the groups that apply to us.
 *
 * A group naming our token beats the wildcard group; when neither exists,
 * everything is allowed. Only `Allow`, `Disallow` and `Crawl-delay` are read.
 */
export function parseRobots(body: string, userAgentToken: string): RobotsRules {
  const token = userAgentToken.toLowerCase();
  const groups = new Map<string, { rules: Array<{ allow: boolean; path: string }>; delay: number | null }>();

  let currentAgents: string[] = [];
  let expectingAgents = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!expectingAgents) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      expectingAgents = true;
      for (const agent of currentAgents) {
        if (!groups.has(agent)) groups.set(agent, { rules: [], delay: null });
      }
      continue;
    }

    expectingAgents = false;
    if (currentAgents.length === 0) continue;

    for (const agent of currentAgents) {
      const group = groups.get(agent)!;
      if (field === 'disallow') group.rules.push({ allow: false, path: value });
      else if (field === 'allow') group.rules.push({ allow: true, path: value });
      else if (field === 'crawl-delay') {
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds)) group.delay = Math.min(seconds, 30) * 1000;
      }
    }
  }

  const group =
    [...groups.entries()].find(([agent]) => token.includes(agent) && agent !== '*')?.[1] ??
    groups.get('*') ??
    null;

  return {
    rules: group?.rules ?? [],
    crawlDelayMs: group?.delay ?? null,
  };
}

/** Longest matching rule wins; an Allow beats a Disallow of equal length. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;

  for (const rule of rules.rules) {
    // An empty Disallow means "allow everything" and matches nothing.
    if (rule.path === '') continue;
    if (!pathMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }

  return best ? best.allow : true;
}

/** robots.txt path matching, including `*` and an anchoring `$`. */
function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern);

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.max(0, Math.min(chunk.byteLength, bytes - offset))), offset);
    offset += chunk.byteLength;
    if (offset >= bytes) break;
  }

  return { text: new TextDecoder('utf-8', { fatal: false }).decode(joined), bytes, truncated };
}

export async function fetchPage(url: string, options: CrawlOptions): Promise<FetchedPage> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-NZ,en;q=0.9',
      },
    });

    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('html') || contentType === '';
    const body = isHtml
      ? await readCapped(response, options.maxBytes)
      : { text: '', bytes: 0, truncated: false };

    return {
      url,
      finalUrl: response.url || url,
      status: response.status,
      contentType,
      bytes: body.bytes,
      elapsedMs: Date.now() - started,
      html: body.text,
      truncated: body.truncated,
    };
  } catch (error) {
    return {
      url,
      finalUrl: url,
      status: 0,
      contentType: '',
      bytes: 0,
      elapsedMs: Date.now() - started,
      html: '',
      truncated: false,
      error: controller.signal.aborted
        ? `Timed out after ${options.timeoutMs}ms`
        : describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|avif|svg|zip|docx?|xlsx?|mp4|mp3|ico|css|js)(\?|$)/i;

/**
 * Rank internal links by how likely they are to tell us something useful.
 * An about or services page is worth far more than a privacy policy.
 */
const PAGE_PRIORITY: Array<[RegExp, number]> = [
  [/\b(about|our-story|who-we-are)\b/i, 10],
  [/\b(services?|what-we-do|treatments?|menu|products?|shop)\b/i, 9],
  [/\b(contact|find-us|book|booking|appointments?)\b/i, 8],
  [/\b(gallery|portfolio|work|projects?)\b/i, 7],
  [/\b(team|staff|people)\b/i, 5],
  [/\b(pricing|rates?)\b/i, 5],
  [/\b(privacy|terms|cookie|sitemap|login|cart|account)\b/i, -20],
];

export function rankCandidate(path: string): number {
  let score = 1;
  for (const [pattern, weight] of PAGE_PRIORITY) {
    if (pattern.test(path)) score += weight;
  }
  // Deep paths are usually individual products or posts.
  score -= Math.max(0, path.split('/').filter(Boolean).length - 2) * 2;
  return score;
}

/**
 * Names that mean "furniture", not photography.
 *
 * Kept deliberately narrow. Over-filtering costs a demo its only picture,
 * which is worse than one badge slipping through — the download step checks
 * the real dimensions afterwards anyway.
 */
const FURNITURE = /\b(logo|icon|favicon|sprite|badge|avatar|payment|visa|mastercard|paypal|afterpay|flag|arrow|chevron|bullet|divider|pattern|texture|watermark)\b/i;

/** Formats that are never the photograph we are looking for. */
const NON_PHOTO = /\.(svg|gif|ico)(\?|$)/i;

/**
 * How promising an image is as demo photography, or null to discard it.
 *
 * The signals are all cheap and all available from markup alone: what kind of
 * element it came from, whether the author wrote an alt, and what size they
 * declared. Anything declared smaller than a thumbnail is furniture whatever
 * it is called.
 */
export function scoreImage(image: ExtractedImage): number | null {
  if (FURNITURE.test(image.src)) return null;
  if (NON_PHOTO.test(image.src)) return null;

  // A declared size is a fact about intent: nobody lays out a photograph at
  // 48 square. Where only one dimension is given, judge on that alone.
  const largest = Math.max(image.width, image.height);
  if (largest > 0 && largest < 200) return null;

  let score = 10;

  // `<picture>` and `srcset` mean someone prepared this image at several
  // sizes, which is something people do for photographs and not for badges.
  if (image.origin === 'picture') score += 25;
  else if (image.origin === 'srcset') score += 20;
  else if (image.origin === 'background') score += 12;

  if (image.alt.trim().length > 3) score += 8;
  if (largest >= 1200) score += 15;
  else if (largest >= 600) score += 8;

  // Paths that name a gallery are worth more than ones that name a theme.
  if (/\b(gallery|portfolio|photo|hero|banner|work|project|product|menu)\b/i.test(image.src)) score += 10;
  if (/\b(theme|assets\/img\/ui|wp-includes|plugins?)\b/i.test(image.src)) score -= 8;

  return score;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Crawl a site: robots.txt, the root, then the most promising internal pages.
 */
export async function crawlSite(
  website: string,
  options: Partial<CrawlOptions> = {},
): Promise<CrawlResult> {
  const opts = { ...DEFAULT_CRAWL, ...options };

  let root: URL;
  try {
    root = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  } catch {
    return emptyCrawl(website, `"${website}" is not a usable URL.`);
  }

  const result: CrawlResult = {
    root: root.toString(),
    pagesRequested: opts.maxPages,
    reachable: false,
    httpsWorks: root.protocol === 'https:',
    robotsFound: false,
    disallowed: [],
    pages: [],
    socials: [],
    emails: [],
    phones: [],
    images: [],
  };

  // robots.txt first, always.
  let robots: RobotsRules = { rules: [], crawlDelayMs: null };
  const robotsResponse = await fetchPage(new URL('/robots.txt', root).toString(), {
    ...opts,
    maxBytes: 100_000,
  });
  if (robotsResponse.status === 200 && robotsResponse.html) {
    result.robotsFound = true;
    robots = parseRobots(robotsResponse.html, opts.userAgent);
  }

  const delay = Math.max(opts.politenessMs, robots.crawlDelayMs ?? 0);

  const queue: string[] = [root.toString()];
  const visited = new Set<string>();
  const allLinks = new Set<string>();

  while (queue.length > 0 && result.pages.length < opts.maxPages) {
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);

    const path = new URL(next).pathname;
    if (!robotsAllows(robots, path)) {
      result.disallowed.push(path);
      continue;
    }

    if (result.pages.length > 0) await sleep(delay);

    let page = await fetchPage(next, opts);

    // A site that only answers on http is itself a finding, not a failure.
    if (page.status === 0 && next.startsWith('https://') && result.pages.length === 0) {
      const overHttp = await fetchPage(next.replace(/^https:/, 'http:'), opts);
      if (overHttp.status > 0) {
        result.httpsWorks = false;
        page = overHttp;
      }
    }

    if (page.status === 0 || !page.html) {
      if (result.pages.length === 0 && page.error) result.error = page.error;
      continue;
    }

    result.reachable = true;
    const extracted = extractPage(page.html, page.finalUrl);
    result.pages.push({ ...page, extracted });

    for (const link of extracted.links) {
      let resolved: URL;
      try {
        resolved = new URL(link.href, page.finalUrl);
      } catch {
        continue;
      }
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      resolved.hash = '';
      allLinks.add(resolved.toString());

      const sameSite =
        resolved.hostname.replace(/^www\./, '') === root.hostname.replace(/^www\./, '');
      if (!sameSite || SKIP_EXTENSIONS.test(resolved.pathname)) continue;
      if (visited.has(resolved.toString())) continue;
      queue.push(resolved.toString());
    }

    // Re-rank what is left so the next fetch is the most informative one.
    queue.sort((a, b) => rankCandidate(new URL(b).pathname) - rankCandidate(new URL(a).pathname));
  }

  result.socials = findSocialLinks(allLinks);
  result.emails = [...new Set(result.pages.flatMap((p) => p.extracted.emails))].slice(0, 10);
  result.phones = [...new Set(result.pages.flatMap((p) => p.extracted.phones))].slice(0, 10);

  const images = new Map<string, number>();
  for (const page of result.pages) {
    if (page.extracted.ogImage) images.set(page.extracted.ogImage, 120);
    for (const image of page.extracted.images) {
      const score = scoreImage(image);
      if (score === null) continue;
      // An image used on more than one page is usually a real photograph the
      // business is proud of rather than a one-off.
      images.set(image.src, Math.max(images.get(image.src) ?? 0, score) + (images.has(image.src) ? 4 : 0));
    }
  }
  result.images = [...images.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([src]) => src)
    .slice(0, 12);

  return result;
}

function emptyCrawl(website: string, error: string): CrawlResult {
  return {
    root: website,
    pagesRequested: 0,
    reachable: false,
    httpsWorks: false,
    robotsFound: false,
    disallowed: [],
    pages: [],
    socials: [],
    emails: [],
    phones: [],
    images: [],
    error,
  };
}
