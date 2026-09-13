import { describe, expect, it } from 'vitest';
import { parseRobots, rankCandidate, robotsAllows } from '~/lib/growth/crawl';

const UA = 'JWBSStudioGrowth/1.0 (+https://billing.jwbsstudio.com)';

describe('robots.txt', () => {
  it('allows everything when there are no rules', () => {
    expect(robotsAllows(parseRobots('', UA), '/anything')).toBe(true);
  });

  it('honours a wildcard disallow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /admin', UA);
    expect(robotsAllows(rules, '/admin/users')).toBe(false);
    expect(robotsAllows(rules, '/about')).toBe(true);
  });

  it('prefers a group naming us over the wildcard group', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: JWBSStudioGrowth', 'Disallow: /private'].join('\n'),
      UA,
    );
    expect(robotsAllows(rules, '/about')).toBe(true);
    expect(robotsAllows(rules, '/private/x')).toBe(false);
  });

  it('lets the longest match win, and an Allow win a tie', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /shop', 'Allow: /shop/lookbook'].join('\n'),
      UA,
    );
    expect(robotsAllows(rules, '/shop/cart')).toBe(false);
    expect(robotsAllows(rules, '/shop/lookbook/spring')).toBe(true);
  });

  it('treats an empty Disallow as allowing everything', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:', UA), '/anything')).toBe(true);
  });

  it('handles wildcards and end-anchors', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /a/*/secret'].join('\n'),
      UA,
    );
    expect(robotsAllows(rules, '/files/report.pdf')).toBe(false);
    expect(robotsAllows(rules, '/files/report.pdf.html')).toBe(true);
    expect(robotsAllows(rules, '/a/b/secret')).toBe(false);
  });

  it('shares one rule group across consecutive User-agent lines', () => {
    const rules = parseRobots(
      ['User-agent: SomeoneElse', 'User-agent: JWBSStudioGrowth', 'Disallow: /nope'].join('\n'),
      UA,
    );
    expect(robotsAllows(rules, '/nope')).toBe(false);
  });

  it('reads and clamps crawl-delay', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 2', UA).crawlDelayMs).toBe(2000);
    expect(parseRobots('User-agent: *\nCrawl-delay: 9000', UA).crawlDelayMs).toBe(30_000);
  });

  it('ignores comments and unknown directives', () => {
    const rules = parseRobots(
      ['# a comment', 'Sitemap: https://x.example/sitemap.xml', 'User-agent: *', 'Disallow: /x # trailing'].join('\n'),
      UA,
    );
    expect(robotsAllows(rules, '/x')).toBe(false);
    expect(robotsAllows(rules, '/y')).toBe(true);
  });
});

describe('page ranking', () => {
  it('prefers the pages that say something about the business', () => {
    expect(rankCandidate('/about')).toBeGreaterThan(rankCandidate('/blog/2019/some-post'));
    expect(rankCandidate('/services')).toBeGreaterThan(rankCandidate('/'));
  });

  it('ranks boilerplate below everything', () => {
    expect(rankCandidate('/privacy')).toBeLessThan(0);
    expect(rankCandidate('/terms')).toBeLessThan(0);
  });
});
