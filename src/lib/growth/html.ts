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

  const images: ExtractedImage[] = [];
  for (const tag of structure.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, 'src') || attr(tag, 'data-src');
    if (!src || src.startsWith('data:')) continue;
    images.push({ src: absolute(src, baseUrl) || src, alt: attr(tag, 'alt') });
  }

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
