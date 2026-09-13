import { describe, expect, it } from 'vitest';
import { assessScale, renderScale } from '~/lib/growth/scale';
import { capFitToScale } from '~/lib/growth/qualify';
import { isPlausibleMatch } from '~/lib/growth/search';
import { extractPage } from '~/lib/growth/html';
import type { CrawlResult } from '~/lib/growth/crawl';

function crawlOf(html: string, overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    root: 'https://example.test/',
    pagesRequested: 6,
    reachable: true,
    httpsWorks: true,
    robotsFound: true,
    disallowed: [],
    pages: [
      {
        url: 'https://example.test/',
        finalUrl: 'https://example.test/',
        status: 200,
        contentType: 'text/html',
        bytes: html.length,
        elapsedMs: 200,
        html,
        truncated: false,
        extracted: extractPage(html, 'https://example.test/'),
      },
    ],
    socials: [],
    emails: [],
    phones: [],
    images: [],
    ...overrides,
  };
}

const INDEPENDENT = `<html><body>
  <h1>Wells Coffee</h1>
  <p>We roast on Tuesdays in a shed in Te Aro.</p>
  <a href="/about">About</a><a href="/contact">Contact</a>
  <footer>© 2026 Wells Coffee</footer>
</body></html>`;

const ESTABLISHED = `<html><body>
  <h1>A Roastery Group</h1>
  <nav>
    <a href="/about">About</a><a href="/careers">Careers</a><a href="/press">Press</a>
    <a href="/wholesale">Wholesale</a><a href="/our-stores">Our stores</a>
    <a href="/sustainability">Sustainability</a><a href="/gift-cards">Gift cards</a>
  </nav>
  <p>Visit any of our stores nationwide. Our team of 80 people roast daily.</p>
  <script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>
  <footer>Site designed by Somebody Studio</footer>
</body></html>`;

describe('scale assessment', () => {
  it('leaves an independent business alone', () => {
    const scale = assessScale({ name: 'Wells Coffee' }, crawlOf(INDEPENDENT));
    expect(scale.score).toBeLessThan(20);
    expect(scale.decisive).toBe(false);
    expect(scale.summary).toContain('single independent business');
  });

  it('settles it outright on a Wikidata-tagged brand', () => {
    // This is the Toby's Estate case: a prominent roaster that OpenStreetMap
    // already tags as a known brand. The old pipeline scored it as a *good*
    // prospect because it could obviously afford design work.
    const scale = assessScale(
      { name: "Toby's Estate", brand: "Toby's Estate", brandWikidata: 'Q7811872', branchCount: 4 },
      crawlOf(INDEPENDENT),
    );

    expect(scale.decisive).toBe(true);
    expect(scale.score).toBeGreaterThan(60);
    expect(scale.summary).toContain('recognised chain');
  });

  it('treats several branches in one region as conclusive on its own', () => {
    const scale = assessScale({ name: 'Three Shops', branchCount: 3 }, crawlOf(INDEPENDENT));
    expect(scale.decisive).toBe(true);
    expect(scale.summary).toContain('3 branches');
  });

  it('does not call two branches a chain outright', () => {
    const scale = assessScale({ name: 'Two Shops', branchCount: 2 }, crawlOf(INDEPENDENT));
    expect(scale.decisive).toBe(false);
    expect(scale.score).toBeGreaterThan(0);
  });

  it('accumulates the signs of an established operation', () => {
    const scale = assessScale({ name: 'A Roastery Group' }, crawlOf(ESTABLISHED));
    const hits = scale.signals.filter((s) => s.hit).map((s) => s.id);

    expect(hits).toContain('page:Careers page');
    expect(hits).toContain('page:Press or media page');
    expect(hits).toContain('page:Store locator');
    expect(hits).toContain('stack:Klaviyo');
    expect(hits).toContain('agency-credit');
    expect(scale.score).toBeGreaterThan(60);
  });

  it('counts a lot of reviews as reach', () => {
    const quiet = assessScale({ name: 'X', reviewCount: 40 }, crawlOf(INDEPENDENT));
    const loud = assessScale({ name: 'X', reviewCount: 3000 }, crawlOf(INDEPENDENT));
    expect(loud.score).toBeGreaterThan(quiet.score);
  });

  it('works with nothing to crawl', () => {
    const scale = assessScale({ name: 'No Website Ltd' }, null);
    expect(scale.score).toBe(0);
    expect(() => renderScale(scale)).not.toThrow();
  });

  it('never leaves the 0..100 range', () => {
    const scale = assessScale(
      { name: 'Everything', brandWikidata: 'Q1', branchCount: 40, reviewCount: 90_000 },
      crawlOf(ESTABLISHED),
    );
    expect(scale.score).toBeLessThanOrEqual(100);
    expect(scale.score).toBeGreaterThanOrEqual(0);
  });
});

describe('scale as a ceiling on fit', () => {
  const decisive = { score: 80, decisive: true, signals: [], brand: '', branchCount: 4, summary: '' };
  const modest = { score: 20, decisive: false, signals: [], brand: '', branchCount: 1, summary: '' };

  it('floors fit for a conclusive chain, whatever the model said', () => {
    // The prompt tells the model to do this. The cap is what makes it true.
    expect(capFitToScale(95, decisive)).toBeLessThanOrEqual(5);
  });

  it('leaves a small business untouched', () => {
    expect(capFitToScale(80, modest)).toBe(80);
  });

  it('does not penalise below the threshold', () => {
    expect(capFitToScale(90, { ...modest, score: 45 })).toBe(90);
  });

  it('tapers rather than cliff-edging above it', () => {
    const mid = capFitToScale(90, { ...modest, score: 70 });
    const high = capFitToScale(90, { ...modest, score: 90 });
    expect(mid).toBeLessThan(90);
    expect(high).toBeLessThan(mid);
    expect(high).toBeGreaterThanOrEqual(0);
  });

  it('never raises a low score', () => {
    expect(capFitToScale(10, modest)).toBe(10);
    expect(capFitToScale(10, { ...modest, score: 95 })).toBeLessThanOrEqual(10);
  });
});

describe('Wikidata matching', () => {
  it('accepts an exact name for an organisation', () => {
    expect(isPlausibleMatch("Toby's Estate", "Toby's Estate", 'Australian coffee roaster company')).toBe(true);
  });

  it('ignores legal suffixes and punctuation when comparing', () => {
    expect(isPlausibleMatch('Wells Coffee Ltd', 'Wells Coffee', 'coffee roaster business')).toBe(true);
  });

  it('refuses a partial name match', () => {
    // The dangerous failure: writing off every café whose name shares a word
    // with something famous. A missed chain is recoverable; silently deleting
    // good prospects is not.
    expect(isPlausibleMatch('Wells Coffee', 'Wells Fargo', 'American bank')).toBe(false);
    expect(isPlausibleMatch('Estate Coffee', "Toby's Estate", 'coffee company')).toBe(false);
  });

  it('refuses an entity that is plainly not a business', () => {
    expect(isPlausibleMatch('Black Coffee', 'Black Coffee', 'song by an artist')).toBe(false);
    expect(isPlausibleMatch('Hamilton', 'Hamilton', 'city in New Zealand')).toBe(false);
  });

  it('accepts an exact match with no description', () => {
    expect(isPlausibleMatch('Wells Coffee', 'Wells Coffee', '')).toBe(true);
  });
});
