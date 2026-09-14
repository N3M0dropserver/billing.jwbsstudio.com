/**
 * OpenStreetMap discovery, via Nominatim for the region and Overpass for the
 * businesses inside it.
 *
 * This is the default because it needs no key, no billing account and no
 * contract. The data is ODbL: you may use it and build on it, and if you
 * redistribute a derived database you must credit OpenStreetMap and share
 * alike. Showing prospects in your own admin, and writing to a business you
 * found, is not redistribution — but the attribution note is carried through
 * on every run so the obligation is not quietly lost.
 *
 * Both services are donated infrastructure with published usage policies:
 * one request at a time, a real User-Agent, and no hammering. Both are
 * honoured here — the retry below is sequential, bounded to two passes over
 * the mirror list, and waits between them. Do not raise the limits without
 * reading their policies.
 *
 * Coverage is the honest trade-off. OSM is excellent for anything with a
 * shopfront and thinner for businesses that work from home or from a van;
 * for those, Google Places is the better provider.
 */

import { describeError } from '../../errors';
import type {
  DiscoveredBusiness,
  DiscoveryProvider,
  DiscoveryRequest,
  DiscoveryResult,
} from './types';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/**
 * Mirrors, tried in order. The main instance is the busiest, and the list is
 * worth more than its order: when one of these is overloaded it does not fail
 * quickly, it holds the connection until something in front of it gives up
 * and returns a gateway error. Having somewhere else to go is the whole
 * defence.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * One attempt's patience. The query itself asks Overpass for `timeout:60`, so
 * a healthy server either answers or gives up inside that; waiting much
 * longer only holds the run open while nothing happens.
 */
const ATTEMPT_TIMEOUT_MS = 70_000;
/** Passes over the whole mirror list. Two: enough for a blip, not enough to labour an outage. */
const OVERPASS_ROUNDS = 2;
/** Ceiling on the lot, so a stage cannot sit here indefinitely. */
const OVERPASS_BUDGET_MS = 180_000;
/** Between rounds. These are donated servers; going straight back at one is rude and futile. */
const OVERPASS_BACKOFF_MS = 3_000;

/**
 * Statuses worth trying somewhere else.
 *
 * 429 is the published rate limit. 502/503/504 are the server saying it is
 * out of capacity, and 520-524 are Cloudflare in front of a mirror saying the
 * same thing less clearly — 524 in particular means the mirror accepted the
 * query and then took longer than the proxy would wait. None of them says
 * anything about the query, so the same query is worth sending elsewhere.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

const ATTRIBUTION = 'Business data © OpenStreetMap contributors, ODbL.';

/**
 * Niche to OSM tag filters.
 *
 * Keys are matched as substrings against the lower-cased niche, longest
 * first, so "coffee roaster" beats "coffee". Values are complete tag
 * filters in Overpass syntax.
 */
const NICHE_TAGS: Array<[string, string[]]> = [
  ['coffee roast', ['"craft"="coffee_roaster"', '"shop"="coffee"']],
  ['roaster', ['"craft"="coffee_roaster"']],
  ['cafe', ['"amenity"="cafe"']],
  ['coffee', ['"amenity"="cafe"', '"shop"="coffee"']],
  ['restaurant', ['"amenity"="restaurant"']],
  ['bar', ['"amenity"="bar"', '"amenity"="pub"']],
  ['brewery', ['"craft"="brewery"', '"industrial"="brewery"']],
  ['winery', ['"craft"="winery"', '"shop"="wine"']],
  ['distiller', ['"craft"="distillery"']],
  ['bakery', ['"shop"="bakery"']],
  ['butcher', ['"shop"="butcher"']],
  ['florist', ['"shop"="florist"']],
  ['hairdress', ['"shop"="hairdresser"']],
  ['barber', ['"shop"="hairdresser"']],
  ['salon', ['"shop"="beauty"', '"shop"="hairdresser"']],
  ['beauty', ['"shop"="beauty"']],
  ['tattoo', ['"shop"="tattoo"']],
  ['spa', ['"leisure"="spa"', '"shop"="beauty"']],
  ['gym', ['"leisure"="fitness_centre"']],
  ['fitness', ['"leisure"="fitness_centre"']],
  ['yoga', ['"leisure"="fitness_centre"', '"sport"="yoga"']],
  ['physio', ['"healthcare"="physiotherapist"']],
  ['dentist', ['"amenity"="dentist"', '"healthcare"="dentist"']],
  ['doctor', ['"amenity"="doctors"', '"healthcare"="doctor"']],
  ['vet', ['"amenity"="veterinary"']],
  ['optometr', ['"shop"="optician"']],
  ['pharmac', ['"amenity"="pharmacy"']],
  ['chiroprac', ['"healthcare"="chiropractor"']],
  ['massage', ['"shop"="massage"', '"healthcare"="massage"']],
  ['accountant', ['"office"="accountant"']],
  ['lawyer', ['"office"="lawyer"']],
  ['solicitor', ['"office"="lawyer"']],
  ['architect', ['"office"="architect"']],
  ['engineer', ['"office"="engineer"']],
  ['estate agent', ['"office"="estate_agent"']],
  ['real estate', ['"office"="estate_agent"']],
  ['insurance', ['"office"="insurance"']],
  ['travel agent', ['"shop"="travel_agency"']],
  ['builder', ['"craft"="builder"', '"shop"="trade"']],
  ['carpenter', ['"craft"="carpenter"']],
  ['joiner', ['"craft"="joiner"', '"craft"="carpenter"']],
  ['plumber', ['"craft"="plumber"']],
  ['electrician', ['"craft"="electrician"']],
  ['roofer', ['"craft"="roofer"']],
  ['painter', ['"craft"="painter"']],
  ['landscap', ['"craft"="gardener"', '"shop"="garden_centre"']],
  ['garden', ['"shop"="garden_centre"', '"craft"="gardener"']],
  ['nursery', ['"shop"="garden_centre"']],
  ['mechanic', ['"shop"="car_repair"']],
  ['panelbeat', ['"shop"="car_repair"']],
  ['car yard', ['"shop"="car"']],
  ['car deal', ['"shop"="car"']],
  ['tyre', ['"shop"="tyres"']],
  ['bike', ['"shop"="bicycle"']],
  ['jewell', ['"shop"="jewelry"', '"craft"="jeweller"']],
  ['furniture', ['"shop"="furniture"']],
  ['gallery', ['"tourism"="gallery"', '"shop"="art"']],
  ['photograph', ['"shop"="photo"', '"craft"="photographer"']],
  ['print', ['"shop"="copyshop"', '"craft"="printer"']],
  ['sign', ['"craft"="signmaker"']],
  ['clothing', ['"shop"="clothes"']],
  ['boutique', ['"shop"="clothes"']],
  ['book', ['"shop"="books"']],
  ['pet', ['"shop"="pet"', '"shop"="pet_grooming"']],
  ['hotel', ['"tourism"="hotel"']],
  ['motel', ['"tourism"="motel"']],
  ['lodge', ['"tourism"="hotel"', '"tourism"="chalet"']],
  ['bed and breakfast', ['"tourism"="guest_house"']],
  ['holiday park', ['"tourism"="caravan_site"', '"tourism"="camp_site"']],
  ['childcare', ['"amenity"="childcare"', '"amenity"="kindergarten"']],
  ['daycare', ['"amenity"="childcare"']],
  ['driving school', ['"amenity"="driving_school"']],
  ['music', ['"shop"="musical_instrument"', '"amenity"="music_school"']],
  ['cleaner', ['"shop"="laundry"', '"shop"="dry_cleaning"']],
  ['storage', ['"shop"="storage_rental"']],
  ['hardware', ['"shop"="hardware"', '"shop"="doityourself"']],
];

/** OSM element types worth looking at. Nodes, ways and relations all carry POIs. */
const ELEMENT_TYPES = ['node', 'way', 'relation'];

/**
 * Escape a user-supplied string for use inside an Overpass regex literal.
 *
 * Overpass takes the value between double quotes and hands it to a regex
 * engine, so both the quote and the regex metacharacters have to go. Anything
 * outside a conservative allowlist is dropped rather than escaped — a niche
 * with a backslash in it is a typo, not a search.
 */
export function escapeOverpassRegex(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.*+?^${}()|[\]\\'-]/g, '\\$&');
}

/** Pick tag filters for a niche, longest key first so specifics win. */
export function filtersForNiche(niche: string): { filters: string[]; matched: string | null } {
  const needle = niche.toLowerCase().trim();
  const candidates = [...NICHE_TAGS].sort((a, b) => b[0].length - a[0].length);
  for (const [key, filters] of candidates) {
    if (needle.includes(key)) return { filters, matched: key };
  }
  return { filters: [], matched: null };
}

/**
 * Build the Overpass QL for an area and a niche.
 *
 * When the niche maps onto known tags we query those. When it does not we
 * fall back to a name search across the keys businesses actually live under,
 * which is looser but still bounded by the area.
 */
export function buildOverpassQuery(areaId: number, niche: string, limit: number): string {
  const { filters } = filtersForNiche(niche);
  const clauses: string[] = [];

  if (filters.length) {
    for (const filter of filters) {
      for (const type of ELEMENT_TYPES) clauses.push(`  ${type}[${filter}](area.searchArea);`);
    }
  } else {
    const pattern = escapeOverpassRegex(niche);
    // No tag match: search names, but only on elements that carry a key a
    // business would have, so we do not sweep up streets and buildings.
    for (const key of ['shop', 'craft', 'office', 'amenity', 'healthcare', 'tourism', 'leisure']) {
      for (const type of ELEMENT_TYPES) {
        clauses.push(`  ${type}["${key}"]["name"~"${pattern}",i](area.searchArea);`);
      }
    }
  }

  return [
    `[out:json][timeout:60];`,
    `area(${areaId})->.searchArea;`,
    `(`,
    ...clauses,
    `);`,
    `out center tags ${Math.max(1, Math.min(limit * 3, 400))};`,
  ].join('\n');
}

interface NominatimPlace {
  osm_type?: string;
  osm_id?: number;
  display_name?: string;
  type?: string;
  class?: string;
}

/**
 * Resolve a region name to an Overpass area id.
 *
 * Overpass area ids are derived from OSM ids: relations get 3600000000 added,
 * ways 2400000000. Nodes have no area, so a region that only resolves to a
 * node cannot be used as a boundary.
 */
async function resolveArea(
  request: DiscoveryRequest,
): Promise<{ areaId: number; label: string } | { error: string }> {
  const params = new URLSearchParams({
    q: request.region,
    format: 'json',
    limit: '5',
    addressdetails: '0',
  });
  const code = request.country.toLowerCase();
  if (code === 'nz' || code === 'au') params.set('countrycodes', code);

  let response: Response;
  try {
    response = await fetch(`${NOMINATIM}?${params}`, {
      headers: { 'user-agent': request.userAgent, accept: 'application/json' },
    });
  } catch (error) {
    return { error: `Could not reach Nominatim: ${String(error)}` };
  }

  if (!response.ok) {
    return { error: `Nominatim returned ${response.status} looking up "${request.region}".` };
  }

  let places: NominatimPlace[];
  try {
    places = (await response.json()) as NominatimPlace[];
  } catch {
    return { error: 'Nominatim returned something that was not JSON.' };
  }

  for (const place of places) {
    if (!place.osm_id) continue;
    if (place.osm_type === 'relation') {
      return { areaId: 3600000000 + place.osm_id, label: place.display_name ?? request.region };
    }
    if (place.osm_type === 'way') {
      return { areaId: 2400000000 + place.osm_id, label: place.display_name ?? request.region };
    }
  }

  return {
    error:
      `"${request.region}" did not resolve to an area OpenStreetMap can search inside. ` +
      'Try a town, city or district name rather than a street or a suburb nickname.',
  };
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
}

interface OverpassAttempt {
  host: string;
  reason: string;
  /** Whether another mirror is worth trying, or the query itself is at fault. */
  retryable: boolean;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** One mirror, once. */
async function askOverpass(
  endpoint: string,
  query: string,
  userAgent: string,
): Promise<{ elements: OverpassElement[] } | { failure: OverpassAttempt }> {
  const host = hostOf(endpoint);
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgent,
        accept: 'application/json',
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      failure: {
        host,
        reason: timedOut
          ? `did not answer within ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s`
          : `could not be reached (${describeError(error)})`,
        retryable: true,
      },
    };
  }

  if (!response.ok) {
    return {
      failure: {
        host,
        reason: `returned ${response.status}`,
        // A 400 is Overpass rejecting the query itself. Every mirror runs the
        // same engine, so asking the next one is just three more failures.
        retryable: RETRYABLE_STATUS.has(response.status),
      },
    };
  }

  let body: { elements?: OverpassElement[]; remark?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    return {
      failure: {
        host,
        reason: `answered with something that was not JSON (${describeError(error)})`,
        retryable: true,
      },
    };
  }

  /**
   * Overpass reports its own timeouts and memory limits in a `remark` on an
   * otherwise successful 200, usually alongside a partial `elements`. Taking
   * that at face value silently discards most of a region.
   */
  if (body.remark && /error|timed out|out of memory/i.test(body.remark)) {
    return {
      failure: { host, reason: `gave up on the query (${body.remark.trim()})`, retryable: true },
    };
  }

  return { elements: body.elements ?? [] };
}

function summarise(attempts: OverpassAttempt[]): string {
  if (!attempts.length) return 'No OpenStreetMap mirror was asked.';

  // One line per mirror, showing how it failed last, rather than a list with
  // the same host in it three times.
  const latest = new Map<string, string>();
  for (const attempt of attempts) latest.set(attempt.host, attempt.reason);

  const detail = [...latest].map(([host, reason]) => `${host} ${reason}`).join('; ');
  return `No OpenStreetMap mirror could run the search: ${detail}.`;
}

/**
 * Ask Overpass, working through the mirrors and then round again.
 *
 * The retry matters more here than in most places. Overpass is donated
 * infrastructure with no capacity guarantee, and a busy mirror fails by
 * timing out rather than by refusing — so a run that gives up on the first
 * gateway error throws away an entire campaign over a few seconds of load
 * somewhere else.
 */
export async function runOverpass(
  query: string,
  userAgent: string,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ elements: OverpassElement[] } | { error: string }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const started = now();
  const attempts: OverpassAttempt[] = [];

  for (let round = 0; round < OVERPASS_ROUNDS; round++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (now() - started >= OVERPASS_BUDGET_MS) {
        const spent = Math.round((now() - started) / 1000);
        return { error: `${summarise(attempts)} Gave up after ${spent}s.` };
      }

      const result = await askOverpass(endpoint, query, userAgent);
      if ('elements' in result) return result;

      attempts.push(result.failure);
      if (!result.failure.retryable) {
        return {
          error:
            `${result.failure.host} ${result.failure.reason}. The search itself was refused, ` +
            'so the other mirrors were not tried.',
        };
      }
    }

    if (round + 1 < OVERPASS_ROUNDS) await sleep(OVERPASS_BACKOFF_MS * (round + 1));
  }

  return {
    error:
      `${summarise(attempts)} They are donated servers and this is usually temporary — ` +
      'start the run again in a few minutes, or switch the campaign to another discovery provider.',
  };
}

function addressFrom(tags: Record<string, string>): string {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:suburb'],
    tags['addr:city'] ?? tags['addr:town'],
    tags['addr:postcode'],
  ].filter((part) => part && part.trim());
  return parts.join(', ');
}

/** Turn an OSM element into a business, or null when it is too thin to use. */
export function elementToBusiness(element: OverpassElement): DiscoveredBusiness | null {
  const tags = element.tags ?? {};
  const name = (tags.name ?? tags['name:en'] ?? '').trim();
  // An unnamed POI cannot be researched or written to.
  if (!name) return null;

  const website = (tags.website ?? tags['contact:website'] ?? tags.url ?? '').trim();
  const descriptors = ['shop', 'craft', 'office', 'amenity', 'healthcare', 'tourism', 'leisure']
    .map((key) => (tags[key] ? `${key}=${tags[key]}` : ''))
    .filter(Boolean);

  const context = [
    descriptors.join(' '),
    tags.description ?? '',
    tags.cuisine ? `cuisine ${tags.cuisine}` : '',
    tags.opening_hours ? 'has published hours' : '',
    tags['contact:facebook'] || tags.facebook ? 'has a Facebook page tagged' : '',
    tags['contact:instagram'] || tags.instagram ? 'has an Instagram tagged' : '',
  ]
    .filter(Boolean)
    .join('; ');

  return {
    name,
    brand: (tags.brand ?? '').trim() || undefined,
    brandWikidata: (tags['brand:wikidata'] ?? '').trim() || undefined,
    operator: (tags.operator ?? '').trim() || undefined,
    website: website || undefined,
    email: (tags.email ?? tags['contact:email'] ?? '').trim() || undefined,
    phone: (tags.phone ?? tags['contact:phone'] ?? '').trim() || undefined,
    address: addressFrom(tags) || undefined,
    mapsUrl:
      element.type && element.id
        ? `https://www.openstreetmap.org/${element.type}/${element.id}`
        : undefined,
    context: context || undefined,
    source: 'overpass',
    sourceRef: element.type && element.id ? `${element.type}/${element.id}` : name,
  };
}

export const overpassProvider: DiscoveryProvider = {
  name: 'overpass',
  label: 'OpenStreetMap',
  description:
    'Free and needs no account. Strong on anything with a shopfront, thinner on businesses run ' +
    'from home or a van. Data is ODbL — credit OpenStreetMap if you republish it.',

  unavailableReason(request) {
    if (!request.region.trim()) return 'Discovery by OpenStreetMap needs a region to search inside.';
    if (!request.niche.trim()) return 'Name the trade you are looking for.';
    return null;
  },

  async run(request): Promise<DiscoveryResult> {
    const area = await resolveArea(request);
    if ('error' in area) return { ok: false, error: area.error };

    const query = buildOverpassQuery(area.areaId, request.niche, request.limit);
    const result = await runOverpass(query, request.userAgent);
    if ('error' in result) return { ok: false, error: result.error };

    const notes = [ATTRIBUTION, `Searched inside ${area.label}.`];
    const { matched } = filtersForNiche(request.niche);
    if (!matched) {
      notes.push(
        `No OpenStreetMap category matches "${request.niche}", so this searched business names ` +
          'instead. Expect a looser set of results.',
      );
    }

    /**
     * Chains map one POI per branch. We still want one row per business — but
     * the number of branches is itself the most useful thing OpenStreetMap
     * knows about size, so the duplicates are counted rather than discarded.
     */
    const byKey = new Map<string, DiscoveredBusiness>();
    const branchCounts = new Map<string, number>();

    for (const element of result.elements) {
      const business = elementToBusiness(element);
      if (!business) continue;

      // Group on the brand where there is one, so branches trading under
      // slightly different names still count together.
      const key = (business.brand || business.name).toLowerCase().trim();
      branchCounts.set(key, (branchCounts.get(key) ?? 0) + 1);

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, business);
      } else if (!existing.website && business.website) {
        // Keep the branch that actually knows the website.
        byKey.set(key, { ...business });
      }
    }

    const businesses: DiscoveredBusiness[] = [];
    for (const [key, business] of byKey) {
      businesses.push({ ...business, branchCount: branchCounts.get(key) ?? 1 });
      if (businesses.length >= request.limit) break;
    }

    if (businesses.length === 0) {
      notes.push('Nothing came back. Try a broader region or a more common word for the trade.');
    }

    return { ok: true, data: { businesses, notes } };
  },
};
