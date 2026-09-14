/**
 * Looking at a page the way a visitor does.
 *
 * A plain `fetch` gets the HTML the server sent. For a great many small
 * business sites that is the whole page and nothing more is needed — which is
 * why the crawler in `src/lib/growth/crawl.ts` is still the default path and
 * always will be. But an increasing number of them are a shell plus a bundle:
 * a Squarespace or Wix site fetched from a Worker can come back with a
 * hundred words of boilerplate and no content at all, and everything
 * downstream — the audit, the score, the angle the outreach opens with — is
 * then wrong about a business that actually has a perfectly good site.
 *
 * So: Cloudflare Browser Rendering, over its REST API. Over the REST API
 * rather than the `BROWSER` binding on purpose — the binding needs a
 * Puppeteer dependency in both Workers and a session limit to reason about,
 * while a POST needs a token. There is nothing here that a binding would do
 * better at this scale.
 *
 * Everything degrades. With no token configured, `readPage` returns what
 * `fetch` got and says it did; a rendering that times out is a page read the
 * ordinary way, not a failed stage. The pipeline that existed before this
 * file still runs if none of it is set up.
 */

import type { BrowserMode } from '../db/schema';
import {
  fetchPage,
  parseRobots,
  robotsAllows,
  DEFAULT_CRAWL,
  type CrawlOptions,
  type RobotsRules,
} from '../growth/crawl';
import { extractPage, type ExtractedPage } from '../growth/html';

export type { BrowserMode };

export interface BrowserConfig {
  accountId: string;
  apiToken: string;
  /** Ceiling on one rendering. Browser Rendering's own cap is higher. */
  timeoutMs: number;
}

/**
 * The token needs the Browser Rendering permission. It is the same secret the
 * DNS step already uses when demo subdomains get their own records, and a
 * token scoped to only one of the two simply fails the other — which is
 * reported rather than hidden, because "the browser silently stopped being
 * used" is exactly the kind of thing that makes results drift for weeks.
 */
export function browserConfig(env: {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  BROWSER_RENDERING_TOKEN?: string;
}): BrowserConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = (env.BROWSER_RENDERING_TOKEN || env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, timeoutMs: 45_000 };
}

type Endpoint = 'content' | 'markdown' | 'links' | 'screenshot' | 'scrape' | 'pdf' | 'json';

function endpointUrl(config: BrowserConfig, endpoint: Endpoint): string {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/browser-rendering/${endpoint}`;
}

/**
 * Options passed through to the rendering service.
 *
 * `rejectResourceTypes` is the one that matters for cost and speed: a
 * prospect's site is being read for its words and its structure, and fetching
 * every font and tracking pixel to find them out is waste. Images are kept —
 * the image list is part of what enrichment is after.
 */
function gotoOptions(waitMs: number): Record<string, unknown> {
  return {
    gotoOptions: { waitUntil: 'networkidle0', timeout: Math.min(waitMs, 60_000) },
    rejectResourceTypes: ['font', 'media', 'websocket'],
  };
}

export interface BrowserResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Rough round trip, for the step log. */
  elapsedMs: number;
}

async function call<T>(
  config: BrowserConfig,
  endpoint: Endpoint,
  body: Record<string, unknown>,
): Promise<BrowserResult<T>> {
  const started = Date.now();

  try {
    const response = await fetch(endpointUrl(config, endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const elapsedMs = Date.now() - started;

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      return {
        ok: false,
        elapsedMs,
        error:
          response.status === 401 || response.status === 403
            ? `Browser Rendering refused the token (${response.status}). It needs the Browser Rendering permission on this account.`
            : `Browser Rendering returned ${response.status}. ${detail}`,
      };
    }

    const payload = (await response.json()) as {
      success?: boolean;
      result?: T;
      errors?: Array<{ message?: string }>;
    };

    if (payload.success === false) {
      return {
        ok: false,
        elapsedMs,
        error: payload.errors?.map((e) => e.message).filter(Boolean).join('; ') || 'Rendering failed.',
      };
    }

    return { ok: true, data: payload.result as T, elapsedMs };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - started, error: String(error) };
  }
}

/** The rendered HTML, after the page's own scripts have run. */
export async function renderHtml(
  config: BrowserConfig,
  url: string,
  waitMs = 15_000,
): Promise<BrowserResult<string>> {
  return call<string>(config, 'content', { url, ...gotoOptions(waitMs) });
}

/**
 * The page as markdown.
 *
 * The most useful single thing here for a model: headings survive, navigation
 * chrome mostly does not, and a page that would be 200kB of HTML is a couple
 * of thousand words. Research reads markdown; the audit reads HTML, because
 * it is measuring the markup itself.
 */
export async function renderMarkdown(
  config: BrowserConfig,
  url: string,
  waitMs = 15_000,
): Promise<BrowserResult<string>> {
  return call<string>(config, 'markdown', { url, ...gotoOptions(waitMs) });
}

export interface RenderedLink {
  url: string;
  text: string;
}

export async function renderLinks(
  config: BrowserConfig,
  url: string,
  visibleOnly = true,
): Promise<BrowserResult<string[]>> {
  return call<string[]>(config, 'links', { url, visibleLinksOnly: visibleOnly, ...gotoOptions(12_000) });
}

export interface ScrapedElement {
  selector: string;
  results: Array<{ text?: string; html?: string; attributes?: Array<{ name: string; value: string }> }>;
}

/** Pull specific elements out, for when a whole page is more than is needed. */
export async function scrapeElements(
  config: BrowserConfig,
  url: string,
  selectors: string[],
): Promise<BrowserResult<ScrapedElement[]>> {
  return call<ScrapedElement[]>(config, 'scrape', {
    url,
    elements: selectors.slice(0, 12).map((selector) => ({ selector })),
    ...gotoOptions(12_000),
  });
}

export interface Screenshot {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/**
 * A picture of the page.
 *
 * Worth having for two different reasons. Before: what their site looks like
 * today is the most persuasive line in an outreach email, and the one thing
 * that cannot be reconstructed later once they have redesigned. After: a
 * screenshot of the generated demo is how a person checks it is not broken
 * without opening seven tabs.
 *
 * This one endpoint answers with an image rather than JSON, so it does not
 * go through `call`.
 */
export async function screenshot(
  config: BrowserConfig,
  url: string,
  options: { fullPage?: boolean; width?: number; height?: number } = {},
): Promise<BrowserResult<Screenshot>> {
  const started = Date.now();
  const width = options.width ?? 1280;
  const height = options.height ?? 800;

  try {
    const response = await fetch(endpointUrl(config, 'screenshot'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        viewport: { width, height },
        screenshotOptions: { fullPage: options.fullPage ?? false, type: 'png' },
        ...gotoOptions(15_000),
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      return { ok: false, elapsedMs, error: `Screenshot returned ${response.status}. ${detail}` };
    }

    const contentType = response.headers.get('content-type') ?? 'image/png';

    // Some deployments answer with JSON carrying a base64 body instead of the
    // image itself. Both are handled; an image is an image.
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { result?: string; success?: boolean };
      if (!payload.result) return { ok: false, elapsedMs, error: 'The screenshot came back empty.' };
      return {
        ok: true,
        elapsedMs,
        data: { bytes: decodeBase64(payload.result), contentType: 'image/png', width, height },
      };
    }

    const buffer = await response.arrayBuffer();
    return {
      ok: true,
      elapsedMs,
      data: { bytes: new Uint8Array(buffer), contentType, width, height },
    };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - started, error: String(error) };
  }
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/^data:[^,]+,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Reading a page, whichever way works                                 */
/* ------------------------------------------------------------------ */

export interface ReadPageOptions {
  mode: BrowserMode;
  config: BrowserConfig | null;
  crawl?: Partial<CrawlOptions>;
  /** Ask for markdown as well as HTML. Costs a second rendering. */
  wantMarkdown?: boolean;
}

export interface PageRead {
  url: string;
  finalUrl: string;
  status: number;
  /** How it was actually read, which is not always how it was asked for. */
  via: 'fetch' | 'browser';
  html: string;
  markdown: string;
  extracted: ExtractedPage;
  elapsedMs: number;
  /** Set when the browser was tried and did not work. */
  note: string;
  error: string;
}

/**
 * Below this many words, a fetched page is treated as suspicious rather than
 * short. Real one-page sites exist, but they carry an address and an opening
 * time; a shell that renders its content in the client carries neither.
 */
export const THIN_PAGE_WORDS = 60;

export function looksClientRendered(extracted: ExtractedPage, html: string): boolean {
  if (extracted.wordCount >= THIN_PAGE_WORDS) return false;
  // A near-empty body with script tags is the signature. A near-empty body
  // with no scripts is simply a small page, and rendering it changes nothing.
  return /<script[\s>]/i.test(html) || /id="(root|app|__next|___gatsby)"/i.test(html);
}

/**
 * robots.txt, remembered for a quarter of an hour.
 *
 * The crawler reads robots.txt once per crawl. The agent reads one page at a
 * time, several times a task, often from the same host — so without a cache
 * the polite thing to do would double the number of requests we make to
 * somebody's server. Fifteen minutes is short enough that a site which has
 * just asked us to stop is obeyed within the same afternoon.
 */
const robotsCache = new Map<string, { rules: RobotsRules; at: number }>();
const ROBOTS_TTL_MS = 15 * 60 * 1000;

async function robotsFor(origin: string, options: CrawlOptions): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached.rules;

  const response = await fetchPage(`${origin}/robots.txt`, { ...options, maxBytes: 100_000 });
  const rules =
    response.status === 200 && response.html
      ? parseRobots(response.html, options.userAgent)
      : { rules: [], crawlDelayMs: null };

  robotsCache.set(origin, { rules, at: Date.now() });
  return rules;
}

/**
 * May we fetch this URL?
 *
 * Exported because the browser-only tools — links, element extraction,
 * screenshots — reach the page through the rendering service rather than
 * through `readPage`, and a request made on our behalf is still a request
 * made by us.
 */
export async function robotsPermits(url: string, userAgent: string): Promise<boolean> {
  try {
    const target = new URL(url);
    const rules = await robotsFor(target.origin, { ...DEFAULT_CRAWL, userAgent });
    return robotsAllows(rules, target.pathname);
  } catch {
    return true;
  }
}

/**
 * Read one page, escalating to a real browser only when it is worth it.
 *
 * The escalation rule is the whole design: rendering every page would treble
 * the time a run takes and cost real money, and would change the answer for
 * perhaps one site in six. So a fetch happens first, and the browser is asked
 * only when what came back does not look like a page a person would have
 * seen.
 */
export async function readPage(url: string, options: ReadPageOptions): Promise<PageRead> {
  const crawlOptions: CrawlOptions = { ...DEFAULT_CRAWL, maxPages: 1, ...options.crawl };
  const usable = options.mode !== 'off' && options.config !== null;

  const base: PageRead = {
    url,
    finalUrl: url,
    status: 0,
    via: 'fetch',
    html: '',
    markdown: '',
    extracted: extractPage('', url),
    elapsedMs: 0,
    note: '',
    error: '',
  };

  /**
   * robots.txt is checked here, not only in the crawler.
   *
   * These URLs are chosen by a model rather than by a directory, and a
   * rendering service fetching a page we have been asked not to fetch is
   * still us fetching it. A refusal is reported plainly so the agent can say
   * what it could not look at rather than inventing what was on it.
   */
  try {
    const target = new URL(url);
    const rules = await robotsFor(target.origin, crawlOptions);
    if (!robotsAllows(rules, target.pathname)) {
      return {
        ...base,
        note: 'robots.txt asks us not to fetch this path, so we did not.',
        error: 'Disallowed by robots.txt.',
      };
    }
  } catch {
    // An unreadable robots.txt is not a disallowal; carry on as the crawler
    // does.
  }

  if (usable && options.mode === 'always') {
    const rendered = await readWithBrowser(url, options.config!, options.wantMarkdown ?? false);
    if (rendered) return rendered;
    base.note = 'The browser could not render this page, so it was fetched instead.';
  }

  const fetched = await fetchPage(url, crawlOptions);
  const extracted = extractPage(fetched.html, fetched.finalUrl || url);

  const plain: PageRead = {
    ...base,
    finalUrl: fetched.finalUrl || url,
    status: fetched.status,
    html: fetched.html,
    extracted,
    elapsedMs: fetched.elapsedMs,
    error: fetched.error ?? '',
  };

  const worthRendering =
    usable &&
    options.mode !== 'always' &&
    (fetched.status === 0 || looksClientRendered(extracted, fetched.html));

  if (!worthRendering) return plain;

  const rendered = await readWithBrowser(url, options.config!, options.wantMarkdown ?? false);
  if (!rendered) {
    return {
      ...plain,
      note: 'This page looked client-rendered, but the browser could not read it either.',
    };
  }

  // Keep the rendering only if it actually found more. A renderer that
  // returns the same shell has told us the page really is that thin, and the
  // fetched copy is the one with the accurate status code.
  if (rendered.extracted.wordCount <= extracted.wordCount) {
    return { ...plain, note: 'Rendered in a browser as well; it found no more than the fetch did.' };
  }

  return {
    ...rendered,
    status: plain.status || rendered.status,
    note: `Fetched HTML was thin (${extracted.wordCount} words), so this was read in a browser.`,
  };
}

async function readWithBrowser(
  url: string,
  config: BrowserConfig,
  wantMarkdown: boolean,
): Promise<PageRead | null> {
  const html = await renderHtml(config, url);
  if (!html.ok || !html.data) return null;

  const extracted = extractPage(html.data, url);
  let markdown = '';

  if (wantMarkdown) {
    const md = await renderMarkdown(config, url);
    if (md.ok && md.data) markdown = md.data;
  }

  return {
    url,
    finalUrl: url,
    status: 200,
    via: 'browser',
    html: html.data,
    markdown,
    extracted,
    elapsedMs: html.elapsedMs,
    note: '',
    error: '',
  };
}
