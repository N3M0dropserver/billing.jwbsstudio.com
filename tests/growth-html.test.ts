import { describe, expect, it } from 'vitest';
import {
  attr,
  decodeEntities,
  extractPage,
  extractText,
  findSocialLinks,
  normaliseDomain,
} from '~/lib/growth/html';

const PAGE = `<!doctype html>
<html lang="en-NZ">
<head>
  <title>Wells Coffee &amp; Roastery</title>
  <meta name="description" content="Small-batch roasters in Te Aro." />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="generator" content="WordPress 5.2" />
  <meta property="og:image" content="https://wells.example/hero.jpg" />
  <link rel="icon" href="/favicon.ico" />
  <link rel="stylesheet" href="/site.css" />
  <style>body { font-family: "Fraunces", serif; color: #1b1a17; }</style>
</head>
<body>
  <h1>Wells Coffee</h1>
  <h2>Our beans</h2>
  <p>Roasted on Tuesdays.</p>
  <script>var tracker = "<h1>not a heading</h1>";</script>
  <a href="/about">About</a>
  <a href="https://instagram.com/wellscoffee">Instagram</a>
  <a href="https://facebook.com/sharer/sharer.php?u=x">Share</a>
  <a href="mailto:Hello@Wells.example">Email</a>
  <a href="tel:+64%204%20555%200198">Call</a>
  <img src="/img/bags.jpg" alt="Bags of beans" />
  <img src="data:image/gif;base64,R0lGOD" alt="tracking" />
  <form action="/contact"></form>
  <script type="application/ld+json">{"@type":"LocalBusiness","telephone":"04 555 0198"}</script>
  <footer>© 2019 Wells Coffee</footer>
</body>
</html>`;

describe('attribute reading', () => {
  it('handles double, single and bare values', () => {
    expect(attr('<a href="/x">', 'href')).toBe('/x');
    expect(attr("<a href='/y'>", 'href')).toBe('/y');
    expect(attr('<a href=/z >', 'href')).toBe('/z');
  });

  it('returns empty for an absent attribute', () => {
    expect(attr('<a>', 'href')).toBe('');
  });

  it('does not match an attribute whose name is a suffix of another', () => {
    // `data-href` must not answer a request for `href`.
    expect(attr('<a data-href="/no">', 'href')).toBe('');
  });
});

describe('entity decoding', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('&copy; 2019')).toBe('© 2019');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('&notathing;')).toBe('&notathing;');
  });
});

describe('text extraction', () => {
  it('drops script and style content', () => {
    const text = extractText(PAGE);
    expect(text).toContain('Roasted on Tuesdays.');
    expect(text).not.toContain('not a heading');
    expect(text).not.toContain('Fraunces');
  });

  it('keeps block boundaries so words do not run together', () => {
    expect(extractText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
});

describe('page extraction', () => {
  const page = extractPage(PAGE, 'https://wells.example/');

  it('reads the head', () => {
    expect(page.title).toBe('Wells Coffee & Roastery');
    expect(page.metaDescription).toBe('Small-batch roasters in Te Aro.');
    expect(page.viewport).toContain('width=device-width');
    expect(page.generator).toBe('WordPress 5.2');
    expect(page.lang).toBe('en-NZ');
    expect(page.hasFavicon).toBe(true);
    expect(page.hasForm).toBe(true);
    expect(page.ogImage).toBe('https://wells.example/hero.jpg');
  });

  it('reads headings without picking up markup inside scripts', () => {
    expect(page.headings).toEqual([
      { level: 1, text: 'Wells Coffee' },
      { level: 2, text: 'Our beans' },
    ]);
  });

  it('lower-cases emails and strips the mailto scheme', () => {
    expect(page.emails).toContain('hello@wells.example');
  });

  it('decodes tel: links', () => {
    expect(page.phones).toEqual(['+64 4 555 0198']);
  });

  it('resolves image URLs and skips data URIs', () => {
    expect(page.images.map((i) => i.src)).toEqual(['https://wells.example/img/bags.jpg']);
  });

  it('finds the copyright year', () => {
    expect(page.copyrightYear).toBe(2019);
  });

  it('parses JSON-LD', () => {
    expect(page.jsonLd).toEqual([{ '@type': 'LocalBusiness', telephone: '04 555 0198' }]);
  });

  it('does not throw on broken JSON-LD', () => {
    const broken = extractPage(
      '<script type="application/ld+json">{ nope </script>',
      'https://x.example/',
    );
    expect(broken.jsonLd).toEqual([]);
  });

  it('picks up inline colours and fonts', () => {
    expect(page.colours).toContain('#1b1a17');
    expect(page.fontFamilies.join(' ')).toContain('Fraunces');
  });
});

describe('social links', () => {
  it('finds one profile per platform', () => {
    const found = findSocialLinks([
      'https://instagram.com/wellscoffee',
      'https://www.instagram.com/someoneelse',
      'https://nz.linkedin.com/company/wells',
    ]);

    expect(found.map((s) => s.platform).sort()).toEqual(['instagram', 'linkedin']);
    expect(found.find((s) => s.platform === 'instagram')?.handle).toBe('wellscoffee');
  });

  it('ignores share buttons and bare platform links', () => {
    expect(findSocialLinks(['https://facebook.com/sharer/sharer.php?u=x'])).toEqual([]);
    expect(findSocialLinks(['https://twitter.com/'])).toEqual([]);
  });

  it('ignores anything that is not a URL', () => {
    expect(findSocialLinks(['not a url', '/relative'])).toEqual([]);
  });
});

describe('domain normalisation', () => {
  it('strips scheme, www and path', () => {
    expect(normaliseDomain('https://www.Wells.example/about')).toBe('wells.example');
    expect(normaliseDomain('wells.example')).toBe('wells.example');
  });

  it('returns empty for junk', () => {
    expect(normaliseDomain('')).toBe('');
    expect(normaliseDomain('not a domain at all')).toBe('');
  });
});
