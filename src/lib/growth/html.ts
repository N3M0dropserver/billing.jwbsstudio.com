/**
 * HTML extraction, in plain string handling.
 *
 * Workers have `HTMLRewriter`, which is faster and streams — but it exists
 * only inside workerd, and the extraction rules here are the part most worth
 * covering with tests. Portable code that runs in Node under vitest is worth
 * more than the milliseconds, particularly since the crawler caps how much
 * of a page it will read anyway.
 *
 * None of this trusts its input. Everything extracted is somebody else's
 * markup and is treated as data end to end: it is never concatenated into
 * HTML we serve, and where it reaches a model it goes inside a fenced block
 * that says so.
 */

export interface ExtractedLink {
  href: string;
  text: string;
  rel: string;
}

export interface ExtractedImage {
  src: string;
  alt: string;
  /** Declared pixel size, or 0 where the markup did not say. */
  width: number;
  height: number;
  /**
   * How the image was found.
   *
   * Worth keeping, because it predicts quality. A `<picture>` source or a
   * `srcset` candidate is nearly always art-directed content photography; a
   * CSS background is usually a hero; a bare `<img>` is as likely to be a
   * badge or a payment-method logo as it is a photograph.
   */
  origin: 'img' | 'srcset' | 'picture' | 'background';
}

export interface ExtractedPage {
  title: string;
  metaDescription: string;
  lang: string;
  /** The `<meta name="viewport">` content, empty when there is none. */
  viewport: string;
  /** `<meta name="generator">`, which most site builders fill in. */
  generator: string;
  headings: { level: number; text: string }[];
  text: string;
  wordCount: number;
  links: ExtractedLink[];
  images: ExtractedImage[];
  scripts: string[];
  stylesheets: string[];
  emails: string[];
  phones: string[];
  /** Colours seen in inline styles and inline CSS, as written. */
  colours: string[];
  /** Font families named in inline CSS. */
  fontFamilies: string[];
  /** Latest four-digit year in a copyright line, when there is one. */
  copyrightYear: number | null;
  hasFavicon: boolean;
  hasForm: boolean;
  /** Parsed JSON-LD blocks. Useful for opening hours and addresses. */
  jsonLd: unknown[];
  ogImage: string;
}

const BLOCK_TAGS = /<\/?(?:p|div|section|article|header|footer|br|li|tr|h[1-6]|td)\b[^>]*>/gi;

/** Remove a paired tag and everything inside it. */
function stripElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
}

export function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', eacute: 'é',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** Read one attribute off a tag, handling quoted and bare values. */
export function attr(tag: string, name: string): string {
  // The separator before the name must be whitespace or the tag open — `\b`
  // would treat the hyphen in `data-href` as a boundary and answer a request
  // for `href` with the wrong attribute.
  const pattern = new RegExp(
    `(?:^|[\\s<])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const match = tag.match(pattern);
  if (!match) return '';
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '').trim();
}

function metaContent(html: string, nameOrProperty: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = (attr(tag, 'name') || attr(tag, 'property') || attr(tag, 'http-equiv')).toLowerCase();
    if (key === nameOrProperty.toLowerCase()) return attr(tag, 'content');
  }
  return '';
}

export function extractText(html: string): string {
  let body = html;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe']) {
    body = stripElement(body, tag);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep block boundaries as spaces so words either side do not run together.
  body = body.replace(BLOCK_TAGS, ' \n ');
  body = body.replace(/<[^>]+>/g, ' ');
  return decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/**
 * The attributes a lazy-loading image hides its real source in.
 *
 * Ordered by how likely each is to hold the full-size file. Plain `src` comes
 * last on purpose: on a lazy-loaded page it is usually a blurred placeholder
 * or a transparent pixel, and the real photograph is in one of the others.
 */
const LAZY_SRC_ATTRS = [
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-image',
  'data-full-src',
  'data-large-file',
  'src',
];

/**
 * Ordered like `LAZY_SRC_ATTRS`, and for the same reason: where a lazy loader
 * uses both, the plain `srcset` holds the placeholders and the `data-` one
 * holds the photographs.
 */
const SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'srcset'];

/**
 * The widest candidate in a `srcset`.
 *
 * Descriptors come in two flavours — `480w` and `2x` — and a list may mix
 * them or omit them entirely. Width wins where it is given, density is scaled
 * so that `2x` outranks a 1000px candidate, and a bare URL scores lowest so
 * that any described candidate beats it.
 */
export function largestFromSrcset(srcset: string): string {
  let best = '';
  let bestScore = -1;

  // Split on commas that separate candidates rather than commas inside a URL
  // (data URIs and some CDN transforms contain them).
  for (const candidate of srcset.split(/,(?=\s*[^\s,]+\s*(?:[\d.]+[wx])?\s*(?:,|$))|,\s+/)) {
    const parts = candidate.trim().split(/\s+/).filter(Boolean);
    const url = parts[0];
    if (!url) continue;

    const descriptor = parts[1] ?? '';
    const width = /^(\d+)w$/i.exec(descriptor);
    const density = /^([\d.]+)x$/i.exec(descriptor);
    const score = width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 0;

    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

/** URLs named by `background` / `background-image` declarations in some CSS. */
export function backgroundImageUrls(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(
    /background(?:-image)?\s*:[^;}]*?url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
  )) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    if (url) found.push(decodeEntities(url).trim());
  }
  return found;
}

const PIXEL_SRC = /(?:^|\/)(?:1x1|pixel|spacer|blank|placeholder|transparent)\.(?:gif|png|svg)(?:\?|$)/i;

/**
 * Every image on the page, from wherever it is hiding.
 *
 * Reading only `<img src>` finds nothing on a large share of small-business
 * sites: Squarespace, Wix and most WordPress themes lazy-load their
 * photography, art-direct it through `<picture>`, or set the hero as a CSS
 * background. A crawl that misses all of that concludes the business has no
 * photography, and the demo built from it has nothing to show.
 */
function collectImages(html: string, structure: string, baseUrl: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();

  const add = (
    raw: string,
    alt: string,
    origin: ExtractedImage['origin'],
    width = 0,
    height = 0,
  ): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return;
    if (PIXEL_SRC.test(trimmed)) return;

    const src = absolute(trimmed, baseUrl) || trimmed;
    if (seen.has(src)) return;
    seen.add(src);

    images.push({ src, alt, width, height, origin });
  };

  const dimension = (tag: string, name: string): number => {
    const value = Number.parseInt(attr(tag, name), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  // `<picture>` first: its sources are the art-directed ones, and reaching
  // them before the `<img>` fallback means the fallback is skipped as a
  // duplicate only when it genuinely resolves to the same file.
  for (const block of structure.match(/<picture\b[^>]*>[\s\S]*?<\/picture\s*>/gi) ?? []) {
    // One per block, not one per source: the sources of a `<picture>` are the
    // same photograph in different formats and crops, and taking all of them
    // would put the same picture in a gallery three times.
    for (const tag of block.match(/<source\b[^>]*>/gi) ?? []) {
      const srcset = SRCSET_ATTRS.map((name) => attr(tag, name)).find(Boolean) ?? '';
      const best = largestFromSrcset(srcset) || attr(tag, 'src');
      if (best) {
        add(best, '', 'picture');
        break;
      }
    }
  }

  for (const tag of structure.match(/<img\b[^>]*>/gi) ?? []) {
    const alt = attr(tag, 'alt');
    const width = dimension(tag, 'width');
    const height = dimension(tag, 'height');

    // One source per element, best first. Adding both the srcset winner and
    // the `src` fallback would enter the same photograph twice under two URLs,
    // which no amount of de-duplication downstream can tell apart.
    const srcset = SRCSET_ATTRS.map((name) => attr(tag, name)).find(Boolean) ?? '';
    const fromSrcset = srcset ? largestFromSrcset(srcset) : '';

    if (fromSrcset) {
      add(fromSrcset, alt, 'srcset', width, height);
      continue;
    }

    const direct = LAZY_SRC_ATTRS.map((name) => attr(tag, name)).find(
      (value) => value && !value.startsWith('data:'),
    );
    if (direct) add(direct, alt, 'img', width, height);
  }

  // CSS backgrounds, from both `<style>` blocks and inline `style` attributes.
  // These are read from the original HTML because `structure` has had the
  // style elements removed.
  const css = [
    ...(html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []),
    ...(html.match(/style\s*=\s*(?:"[^"]*"|'[^']*')/gi) ?? []),
  ].join('\n');

  for (const url of backgroundImageUrls(css)) add(url, '', 'background');

  return images;
}

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const head = html.slice(0, 200_000);

  /**
   * Structure is read from a copy with the executable and templated regions
   * removed. Markup inside a script string is not markup, and counting a
   * `<h1>` in a tracker's payload as a heading makes the audit wrong in the
   * direction that matters — it hides a page that genuinely has none.
   */
  const structure = ['script', 'style', 'noscript', 'template'].reduce(
    (acc, tag) => stripElement(acc, tag),
    html,
  );

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();

  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';

  const headings: { level: number; text: string }[] = [];
  for (const match of structure.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = extractText(match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level: Number(match[1]), text: text.slice(0, 300) });
  }

  const links: ExtractedLink[] = [];
  for (const match of structure.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const tag = `<a ${match[1] ?? ''}>`;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue;
    links.push({
      href,
      text: extractText(match[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      rel: attr(tag, 'rel'),
    });
  }

  const images = collectImages(html, structure, baseUrl);

  const scripts: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = attr(tag, 'src');
    if (src) scripts.push(absolute(src, baseUrl) || src);
  }

  const stylesheets: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/stylesheet/i.test(attr(tag, 'rel'))) {
      const href = attr(tag, 'href');
      if (href) stylesheets.push(absolute(href, baseUrl) || href);
    }
  }

  const hasFavicon = (html.match(/<link\b[^>]*>/gi) ?? []).some((tag) =>
    /\bicon\b/i.test(attr(tag, 'rel')),
  );

  const text = extractText(html);

  const emails = [
    ...new Set(
      [
        ...links.filter((l) => l.href.toLowerCase().startsWith('mailto:')).map((l) =>
          l.href.slice(7).split('?')[0]!,
        ),
        ...(text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []),
      ]
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && !e.endsWith('.png') && !e.endsWith('.jpg')),
    ),
  ];

  const phones = [
    ...new Set(
      links
        .filter((l) => l.href.toLowerCase().startsWith('tel:'))
        .map((l) => decodeURIComponent(l.href.slice(4)).trim()),
    ),
  ];

  const inlineCss = [
    ...(html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []),
    ...(html.match(/style\s*=\s*"[^"]*"/gi) ?? []),
  ].join('\n');

  const colours = [
    ...new Set(
      (inlineCss.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|oklch\([^)]*\)|hsla?\([^)]*\)/gi) ?? []).map(
        (c) => c.toLowerCase(),
      ),
    ),
  ].slice(0, 40);

  const fontFamilies = [
    ...new Set(
      (inlineCss.match(/font-family\s*:\s*([^;}]+)/gi) ?? []).map((decl) =>
        decl.split(':')[1]!.trim().replace(/['"]/g, '').slice(0, 120),
      ),
    ),
  ].slice(0, 20);

  const years = [...text.matchAll(/(?:©|\(c\)|copyright)[^0-9]{0,20}((?:19|20)\d{2})/gi)].map((m) =>
    Number(m[1]),
  );
  const copyrightYear = years.length ? Math.max(...years) : null;

  const jsonLd: unknown[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      jsonLd.push(JSON.parse(decodeEntities(match[1] ?? '')));
    } catch {
      // Broken JSON-LD is common and tells us nothing worth failing over.
    }
  }

  return {
    title,
    metaDescription: metaContent(head, 'description'),
    lang: attr(htmlTag, 'lang'),
    viewport: metaContent(head, 'viewport'),
    generator: metaContent(head, 'generator'),
    headings,
    text: text.slice(0, 60_000),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    links,
    images,
    scripts,
    stylesheets,
    emails,
    phones,
    colours,
    fontFamilies,
    copyrightYear,
    hasFavicon,
    hasForm: /<form\b/i.test(html),
    jsonLd,
    ogImage: metaContent(head, 'og:image'),
  };
}

const SOCIAL_HOSTS: Array<[string, string]> = [
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['instagram.com', 'instagram'],
  ['linkedin.com', 'linkedin'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['tiktok.com', 'tiktok'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['pinterest.com', 'pinterest'],
  ['vimeo.com', 'vimeo'],
  ['threads.net', 'threads'],
  ['bsky.app', 'bluesky'],
];

export interface SocialLink {
  platform: string;
  url: string;
  handle: string;
}

/** Pick the social profiles out of a set of links, one per platform. */
export function findSocialLinks(links: Iterable<string>): SocialLink[] {
  const found = new Map<string, SocialLink>();

  for (const href of links) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const match = SOCIAL_HOSTS.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    if (!match) continue;

    const [, platform] = match;
    // A share button links to the platform's root; a profile has a path.
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (['sharer', 'share', 'intent', 'sharer.php'].includes(segments[0]!.toLowerCase())) continue;

    if (!found.has(platform)) {
      found.set(platform, {
        platform,
        url: url.toString(),
        handle: segments[0]!.replace(/^@/, '').slice(0, 80),
      });
    }
  }

  return [...found.values()];
}

/** The registrable-ish host: lower-case, no `www.`, no port. */
export function normaliseDomain(input: string): string {
  if (!input) return '';
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}
