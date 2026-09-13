import { describe, expect, it } from 'vitest';
import {
  buildOverpassQuery,
  escapeOverpassRegex,
  filtersForNiche,
  parseManualLine,
  toProviderName,
  getProvider,
} from '~/lib/growth/discovery/index';

describe('niche to OSM tags', () => {
  it('prefers the more specific match', () => {
    expect(filtersForNiche('coffee roasters').matched).toBe('coffee roast');
    expect(filtersForNiche('a nice cafe').matched).toBe('cafe');
  });

  it('reports honestly when it knows nothing', () => {
    expect(filtersForNiche('interpretive dance studios').matched).toBeNull();
  });
});

describe('Overpass query building', () => {
  it('queries tags when the niche is known', () => {
    const query = buildOverpassQuery(3600000001, 'coffee roasters', 20);
    expect(query).toContain('area(3600000001)->.searchArea;');
    expect(query).toContain('"craft"="coffee_roaster"');
    expect(query).not.toContain('~');
  });

  it('falls back to a bounded name search when it does not', () => {
    const query = buildOverpassQuery(3600000001, 'interpretive dance', 20);
    expect(query).toContain('["name"~"interpretive dance",i]');
    // Still restricted to elements a business would carry, not every way.
    expect(query).toContain('["shop"]');
  });

  it('bounds the result count', () => {
    expect(buildOverpassQuery(1, 'cafe', 500)).toMatch(/out center tags 400;$/);
    expect(buildOverpassQuery(1, 'cafe', 0)).toMatch(/out center tags 1;$/);
  });

  it('cannot be broken out of by a crafted niche', () => {
    // A quote or a bracket in the niche must not close the filter and add
    // clauses of somebody else's choosing.
    const query = buildOverpassQuery(1, 'x"];out;node["amenity"="fuel"', 10);
    expect(query).not.toContain('"amenity"="fuel"');
    expect(query.split('out center tags').length).toBe(2);
  });
});

describe('Overpass regex escaping', () => {
  it('strips characters that would change the query', () => {
    expect(escapeOverpassRegex('a"b]c')).not.toMatch(/["\]]/);
  });

  it('escapes regex metacharacters that survive', () => {
    expect(escapeOverpassRegex("Fish 'n' Chips")).toContain("\\'");
  });

  it('collapses whitespace', () => {
    expect(escapeOverpassRegex('  coffee    roasters  ')).toBe('coffee roasters');
  });
});

describe('pasted lines', () => {
  it('reads a name on its own', () => {
    expect(parseManualLine('Wells Coffee', 0)?.name).toBe('Wells Coffee');
  });

  it('picks up a URL, an email and a phone from one line', () => {
    const parsed = parseManualLine(
      'Wells Coffee, wellscoffee.co.nz, hello@wellscoffee.co.nz, 04 555 0198',
      0,
    );
    expect(parsed).toMatchObject({
      name: 'Wells Coffee',
      website: 'https://wellscoffee.co.nz',
      email: 'hello@wellscoffee.co.nz',
    });
    expect(parsed?.phone).toContain('555');
  });

  it('does not mistake the email domain for the website', () => {
    const parsed = parseManualLine('Third Street Bakery, hello@thirdstreet.example', 0);
    expect(parsed?.website).toBeUndefined();
    expect(parsed?.email).toBe('hello@thirdstreet.example');
  });

  it('skips blanks and comments', () => {
    expect(parseManualLine('', 0)).toBeNull();
    expect(parseManualLine('   ', 0)).toBeNull();
    expect(parseManualLine('# a heading', 0)).toBeNull();
  });

  it('records which line it came from', () => {
    expect(parseManualLine('Wells Coffee', 4)?.sourceRef).toBe('line-5');
  });
});

describe('the registry', () => {
  it('only accepts names it knows', () => {
    expect(toProviderName('overpass')).toBe('overpass');
    expect(toProviderName('manual')).toBe('manual');
    expect(toProviderName('something-else')).toBeNull();
    expect(toProviderName(null)).toBeNull();
  });

  it('falls back rather than returning undefined', () => {
    expect(getProvider('overpass').name).toBe('overpass');
  });

  it('says why a provider cannot run before running it', () => {
    const base = { niche: 'cafe', region: 'Wellington', country: 'NZ', limit: 10, userAgent: 'x' };
    expect(getProvider('overpass').unavailableReason(base)).toBeNull();
    expect(getProvider('overpass').unavailableReason({ ...base, region: '' })).toContain('region');
    expect(getProvider('google-places').unavailableReason(base)).toContain('GOOGLE_PLACES_API_KEY');
    expect(getProvider('manual').unavailableReason(base)).toContain('Paste');
  });
});
