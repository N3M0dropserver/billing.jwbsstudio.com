import { describe, expect, it } from 'vitest';
import {
  attr,
  backgroundImageUrls,
  decodeEntities,
  extractPage,
  extractText,
  findSocialLinks,
  largestFromSrcset,
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

describe('finding photography the way real sites hide it', () => {
  const html = `
    <html><body>
      <picture>
        <source media="(min-width: 60rem)" srcset="/img/hero-2000.jpg 2000w, /img/hero-800.jpg 800w" />
        <img src="/img/hero-fallback.jpg" alt="The roastery" width="1600" height="900" />
      </picture>
      <img src="data:image/gif;base64,R0lGOD" data-src="/img/counter.jpg" alt="The counter" />
      <img src="/img/placeholder.gif" data-lazy-src="/img/beans.jpg" alt="Beans" width="1200" />
      <img srcset="/img/small.jpg 400w, /img/large.jpg 1600w" alt="Bags" />
      <img src="/img/logo.svg" alt="Logo" />
      <img src="/img/visa-badge.png" alt="Visa" width="48" height="32" />
      <div style="background-image: url('/img/shopfront.jpg')"></div>
      <style>.band { background: #fff url(/img/band.jpg) no-repeat; }</style>
    </body></html>`;

  const page = extractPage(html, 'https://wells.example/');
  const sources = page.images.map((image) => image.src);

  it('takes the widest candidate from a picture source', () => {
    expect(sources).toContain('https://wells.example/img/hero-2000.jpg');
  });

  it('takes the widest candidate from a srcset', () => {
    expect(sources).toContain('https://wells.example/img/large.jpg');
    expect(sources).not.toContain('https://wells.example/img/small.jpg');
  });

  it('reads the real source out of lazy-loading attributes', () => {
    expect(sources).toContain('https://wells.example/img/counter.jpg');
    expect(sources).toContain('https://wells.example/img/beans.jpg');
  });

  it('finds CSS background images in both style blocks and attributes', () => {
    expect(sources).toContain('https://wells.example/img/shopfront.jpg');
    expect(sources).toContain('https://wells.example/img/band.jpg');
  });

  it('never emits a data URI as an image source', () => {
    expect(sources.some((src) => src.startsWith('data:'))).toBe(false);
  });

  it('records declared dimensions and how each image was found', () => {
    const beans = page.images.find((image) => image.src.endsWith('beans.jpg'));
    expect(beans?.width).toBe(1200);
    expect(beans?.origin).toBe('img');

    const hero = page.images.find((image) => image.src.endsWith('hero-2000.jpg'));
    expect(hero?.origin).toBe('picture');
  });
});

describe('largestFromSrcset', () => {
  it('prefers the widest width descriptor', () => {
    expect(largestFromSrcset('/a.jpg 400w, /b.jpg 1600w, /c.jpg 800w')).toBe('/b.jpg');
  });

  it('prefers the highest density when widths are not given', () => {
    expect(largestFromSrcset('/a.jpg 1x, /b.jpg 3x')).toBe('/b.jpg');
  });

  it('falls back to the only candidate when nothing is described', () => {
    expect(largestFromSrcset('/only.jpg')).toBe('/only.jpg');
  });

  it('is empty for an empty srcset', () => {
    expect(largestFromSrcset('')).toBe('');
  });
});

describe('backgroundImageUrls', () => {
  it('reads quoted, unquoted and shorthand declarations', () => {
    expect(backgroundImageUrls(`a { background-image: url("/one.jpg") }`)).toEqual(['/one.jpg']);
    expect(backgroundImageUrls(`a { background-image: url(/two.jpg) }`)).toEqual(['/two.jpg']);
    expect(backgroundImageUrls(`a { background: #fff url('/three.jpg') no-repeat }`)).toEqual([
      '/three.jpg',
    ]);
  });

  it('ignores declarations with no url', () => {
    expect(backgroundImageUrls('a { background: linear-gradient(red, blue) }')).toEqual([]);
  });
});

describe('one entry per photograph', () => {
  it('does not enter an img twice when it has both a srcset and a src', () => {
    const page = extractPage(
      '<img srcset="/img/large.jpg 1600w" src="/img/fallback.jpg" alt="Beans" />',
      'https://wells.example/',
    );
    expect(page.images).toHaveLength(1);
    expect(page.images[0]?.src).toBe('https://wells.example/img/large.jpg');
  });

  it('takes one source per picture, not one per format', () => {
    const page = extractPage(
      `<picture>
         <source type="image/avif" srcset="/img/hero.avif 1600w" />
         <source type="image/webp" srcset="/img/hero.webp 1600w" />
         <img src="/img/hero.jpg" alt="" />
       </picture>`,
      'https://wells.example/',
    );
    expect(page.images.filter((image) => image.origin === 'picture')).toHaveLength(1);
  });

  it('prefers the lazy srcset over the placeholder one', () => {
    const page = extractPage(
      '<img srcset="/img/blur.jpg 20w" data-srcset="/img/real.jpg 1600w" alt="" />',
      'https://wells.example/',
    );
    expect(page.images[0]?.src).toBe('https://wells.example/img/real.jpg');
  });
});
