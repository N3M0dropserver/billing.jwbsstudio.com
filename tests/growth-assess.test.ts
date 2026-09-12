import { describe, expect, it } from 'vitest';
import { auditSite, combineScores, detectPlatform } from '~/lib/growth/assess';
import { extractPage } from '~/lib/growth/html';
import type { CrawlResult } from '~/lib/growth/crawl';

const NOW = new Date('2026-09-12T00:00:00Z');

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
        elapsedMs: 300,
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

const GOOD = `<!doctype html><html lang="en">
<head><title>Wells Coffee — small-batch roasters in Te Aro</title>
<meta name="description" content="Roasted weekly in Wellington." />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" /></head>
<body><h1>Wells Coffee</h1>
<p>${'We roast in small batches every Tuesday morning. '.repeat(20)}</p>
<a href="mailto:hello@wells.test">Email us</a>
<img src="/roastery.jpg" alt="The roastery" />
<footer>© 2026 Wells Coffee</footer></body></html>`;

const NEGLECTED = `<html><head><title>Home</title></head>
<body bgcolor="#ffffff"><center><font size="3">Welcome to our page</font></center>
<p>Call us.</p><footer>Copyright 2011</footer></body></html>`;

describe('presence audit', () => {
  it('does not call a site one-page when one page was all we asked for', () => {
    const sampled = auditSite(
      { name: 'Wells Coffee', website: 'https://wells.test' },
      crawlOf(GOOD, { pagesRequested: 1 }),
      NOW,
    );
    const full = auditSite(
      { name: 'Wells Coffee', website: 'https://wells.test' },
      crawlOf(GOOD, { pagesRequested: 6 }),
      NOW,
    );

    expect(sampled.checks.find((c) => c.id === 'single-page')?.failed).toBe(false);
    expect(full.checks.find((c) => c.id === 'single-page')?.failed).toBe(true);
  });

  it('scores a business with no website as almost pure need', () => {
    const audit = auditSite({ name: 'Nowhere Ltd' }, null, NOW);
    expect(audit.presenceScore).toBeGreaterThanOrEqual(90);
    expect(audit.signal).toBe('no-website');
  });

  it('distinguishes a maps-only listing from having nothing at all', () => {
    const audit = auditSite({ name: 'X', mapsUrl: 'https://maps.example/x' }, null, NOW);
    expect(audit.signal).toBe('maps-only');
  });

  it('scores a site that does not answer as broken, not absent', () => {
    const audit = auditSite(
      { name: 'X', website: 'https://x.test' },
      { ...crawlOf(''), reachable: false, pages: [], error: 'Timed out' },
      NOW,
    );
    expect(audit.signal).toBe('broken-site');
    expect(audit.observations[0]).toContain('did not respond');
  });

  it('says so plainly when a site is fine', () => {
    const audit = auditSite(
      { name: 'Wells Coffee', website: 'https://wells.test' },
      crawlOf(GOOD, {
        // One page requested and one found: a one-page site is not a finding
        // when one page is all we asked for.
        pagesRequested: 1,
        emails: ['hello@wells.test'],
        images: ['https://wells.test/roastery.jpg'],
        socials: [{ platform: 'instagram', url: 'https://instagram.com/wells', handle: 'wells' }],
      }),
      NOW,
    );

    expect(audit.presenceScore).toBeLessThan(20);
    // Nothing verifiable to open an email with is the point: no observations
    // means the propose stage has nothing honest to lead with.
    expect(audit.observations).toEqual([]);
    expect(audit.summary).toContain('good shape');
  });

  it('keeps positive facts out of the problem list', () => {
    const audit = auditSite(
      { name: 'Wells Coffee', website: 'https://wells.test' },
      crawlOf(GOOD, {
        pagesRequested: 1,
        emails: ['hello@wells.test'],
        images: ['https://wells.test/roastery.jpg'],
        socials: [{ platform: 'instagram', url: 'https://instagram.com/wells', handle: 'wells' }],
      }),
      NOW,
    );

    // An empty `observations` is the signal the later stages act on; a
    // positive fact padding it would quietly defeat that check.
    expect(audit.observations).toEqual([]);
    expect(audit.context.join(' ')).toContain('instagram');
  });

  it('finds the real problems on a neglected site', () => {
    const audit = auditSite(
      { name: 'Old Shop', website: 'https://old.test' },
      crawlOf(NEGLECTED, { httpsWorks: false }),
      NOW,
    );

    const failed = audit.checks.filter((c) => c.failed).map((c) => c.id);
    expect(failed).toContain('no-viewport');
    expect(failed).toContain('no-https');
    expect(failed).toContain('legacy-markup');
    expect(failed).toContain('stale-copyright');
    expect(failed).toContain('weak-title');
    expect(audit.presenceScore).toBeGreaterThan(60);
    expect(audit.signal).toBe('dated-website');
  });

  it('only produces observations that are checkable', () => {
    const audit = auditSite(
      { name: 'Old Shop', website: 'https://old.test' },
      crawlOf(NEGLECTED, { httpsWorks: false }),
      NOW,
    );

    // Everything offered to the email writer must be a fact from the crawl.
    expect(audit.observations.join(' ')).toContain('© 2011');
    expect(audit.observations.join(' ')).toContain('http');
  });

  it('recognises a parked domain before auditing it as a real site', () => {
    const audit = auditSite(
      { name: 'Parked', website: 'https://parked.test' },
      crawlOf('<html><body><h1>This domain is for sale</h1></body></html>'),
      NOW,
    );
    expect(audit.signal).toBe('broken-site');
    expect(audit.summary).toContain('placeholder');
  });

  it('never leaves the 0..100 range', () => {
    const audit = auditSite(
      { name: 'Worst', website: 'https://worst.test' },
      crawlOf('<html><body>x</body></html>', { httpsWorks: false }),
      NOW,
    );
    expect(audit.presenceScore).toBeGreaterThanOrEqual(0);
    expect(audit.presenceScore).toBeLessThanOrEqual(100);
  });
});

describe('platform detection', () => {
  it('flags builders that usually mean a template', () => {
    expect(detectPlatform('<div class="wixstatic">')?.name).toBe('Wix');
    expect(detectPlatform('<link href="/wp-content/x.css">')?.name).toBe('WordPress');
    expect(detectPlatform('<!-- _vti_bin -->')?.name).toContain('FrontPage');
  });

  it('does not penalise a platform that produces good sites', () => {
    expect(detectPlatform('<div data-framer-name="x">framer.com</div>')?.penalty).toBe(0);
  });

  it('returns null when it does not recognise anything', () => {
    expect(detectPlatform('<html><body>hand written</body></html>')).toBeNull();
  });
});

describe('combined score', () => {
  it('weights the measured half more heavily than the judged one', () => {
    // A perfect fit cannot carry a business whose site is already fine.
    expect(combineScores(0, 100)).toBeLessThan(combineScores(100, 0));
  });

  it('stays within range at the extremes', () => {
    expect(combineScores(0, 0)).toBe(0);
    expect(combineScores(100, 100)).toBe(100);
  });
});
