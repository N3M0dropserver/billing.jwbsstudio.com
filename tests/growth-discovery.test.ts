import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOverpassQuery,
  escapeOverpassRegex,
  filtersForNiche,
  parseManualLine,
  toProviderName,
  getProvider,
} from '~/lib/growth/discovery/index';
import { runOverpass } from '~/lib/growth/discovery/overpass';

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

describe('asking Overpass', () => {
  const ok = (elements: unknown[]) =>
    new Response(JSON.stringify({ elements }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const hostsAsked = (calls: unknown[][]) => calls.map(([url]) => new URL(String(url)).host);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** No real waiting, and no real clock, so the budget is testable. */
  const options = { sleep: async () => {}, now: () => 0 };

  it('moves to the next mirror when one times out behind its proxy', async () => {
    // 524 is what started this: kumi accepted the query and Cloudflare gave
    // up waiting for it. Nothing about that says the query is wrong.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(new Response('', { status: 524 }))
      .mockResolvedValueOnce(ok([{ type: 'node', id: 1, tags: { name: 'Kebabs' } }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOverpass('query', 'agent', options);

    expect(result).toEqual({ elements: [{ type: 'node', id: 1, tags: { name: 'Kebabs' } }] });
    expect(hostsAsked(fetchMock.mock.calls)).toHaveLength(3);
  });

  it('goes round the mirrors a second time before giving up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 524 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOverpass('query', 'agent', options);

    const hosts = new Set(hostsAsked(fetchMock.mock.calls));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(hosts.size);
    expect(result).toHaveProperty('error');
    const { error } = result as { error: string };
    // The message names every mirror and how it failed, not just the last one.
    for (const host of hosts) expect(error).toContain(host);
    expect(error).toContain('524');
    expect(error).toMatch(/temporary/i);
  });

  it('does not shop a rejected query around', async () => {
    // 400 is Overpass rejecting the QL itself. Every mirror runs the same
    // engine, so three more attempts only waste three more requests.
    const fetchMock = vi.fn().mockResolvedValue(new Response('parse error', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOverpass('bad query', 'agent', options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((result as { error: string }).error).toContain('400');
  });

  it('treats a partial answer as a failure rather than a small region', async () => {
    // Overpass reports its own timeout in `remark` on a 200, usually with a
    // handful of elements. Accepting that silently discards the region.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            remark: 'runtime error: Query timed out',
            elements: [{ type: 'node', id: 1 }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(ok([{ type: 'node', id: 2 }]));
    vi.stubGlobal('fetch', fetchMock);

    expect(await runOverpass('query', 'agent', options)).toEqual({
      elements: [{ type: 'node', id: 2 }],
    });
  });

  it('reports a mirror that cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));

    const { error } = (await runOverpass('query', 'agent', options)) as { error: string };
    expect(error).toContain('connection reset');
  });
});
