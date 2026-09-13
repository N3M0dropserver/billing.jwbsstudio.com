/**
 * Looking a business up outside its own website.
 *
 * A site tells you what a business says about itself. It does not tell you
 * whether anyone has heard of them — and that is exactly the thing that
 * decides whether an unsolicited concept site is a nice surprise or a waste
 * of everyone's afternoon.
 *
 * Two lookups, in order of how much they cost:
 *
 *   Wikidata  — free, no key, no rate limit worth worrying about. A business
 *               with a Wikidata entity is, by definition, one somebody
 *               thought was notable enough to catalogue. That is a complete
 *               answer on its own for the prominence question.
 *
 *   Web search — optional, behind a key. Adds press coverage and a rough
 *               sense of how much has been written about them. Brave and
 *               Serper are both supported because neither is obviously the
 *               right default.
 *
 * Both fail soft. A business we cannot look up is assessed on its site and
 * its directory entry, which is what the pipeline did before this existed.
 */

export interface ProminenceResult {
  /** A catalogued entity that matches this business. */
  wikidataId: string | null;
  wikidataLabel: string;
  wikidataDescription: string;
  /** Roughly how much has been written about them. Null when not searched. */
  webResultCount: number | null;
  /** Headlines worth showing a human, and worth nothing to a model. */
  mentions: Array<{ title: string; url: string; snippet: string }>;
  /** What actually ran, so an empty result is distinguishable from no lookup. */
  checked: string[];
  notes: string[];
}

export const EMPTY_PROMINENCE: ProminenceResult = {
  wikidataId: null,
  wikidataLabel: '',
  wikidataDescription: '',
  webResultCount: null,
  mentions: [],
  checked: [],
  notes: [],
};

/**
 * Descriptions that mean "an organisation", as opposed to a person, a place,
 * a song or any of the other things that share a name with a café.
 */
const ORGANISATION_WORDS =
  /\b(compan(y|ies)|business|chain|brand|retailer|roaster|manufacturer|corporation|franchise|group|enterprise|firm|restaurant chain|coffeehouse|supermarket|bank|airline)\b/i;

/** Descriptions that mean this is definitely not the business we are after. */
const NOT_A_BUSINESS =
  /\b(song|album|film|movie|novel|given name|surname|family name|village|river|mountain|species|genus|footballer|politician|musician|painting|episode)\b/i;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b(pty|ltd|limited|inc|llc|co|company|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Is this Wikidata hit actually the business in front of us?
 *
 * The guard matters more than the lookup. A loose match would let any café
 * sharing a word with a famous entity be written off as a national chain,
 * which is a worse failure than missing a chain: it silently removes good
 * prospects and nobody would know to look.
 */
export function isPlausibleMatch(
  businessName: string,
  label: string,
  description: string,
): boolean {
  const a = normalise(businessName);
  const b = normalise(label);
  if (!a || !b) return false;
  // The names must be the same, not merely overlapping.
  if (a !== b) return false;
  if (NOT_A_BUSINESS.test(description)) return false;
  return ORGANISATION_WORDS.test(description) || description.trim() === '';
}

interface WikidataSearchResponse {
  search?: Array<{ id?: string; label?: string; description?: string }>;
}

async function lookupWikidata(
  name: string,
  userAgent: string,
): Promise<Pick<ProminenceResult, 'wikidataId' | 'wikidataLabel' | 'wikidataDescription'> & { note?: string }> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name.slice(0, 120),
    language: 'en',
    uselang: 'en',
    format: 'json',
    limit: '5',
    type: 'item',
    origin: '*',
  });

  try {
    const response = await fetch(`https://www.wikidata.org/w/api.php?${params}`, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { wikidataId: null, wikidataLabel: '', wikidataDescription: '', note: `Wikidata returned ${response.status}.` };
    }

    const body = (await response.json()) as WikidataSearchResponse;
    for (const hit of body.search ?? []) {
      const label = hit.label ?? '';
      const description = hit.description ?? '';
      if (hit.id && isPlausibleMatch(name, label, description)) {
        return { wikidataId: hit.id, wikidataLabel: label, wikidataDescription: description };
      }
    }
    return { wikidataId: null, wikidataLabel: '', wikidataDescription: '' };
  } catch (error) {
    return { wikidataId: null, wikidataLabel: '', wikidataDescription: '', note: `Wikidata lookup failed: ${error}` };
  }
}

/* ------------------------------------------------------------------ */
/* Web search                                                          */
/* ------------------------------------------------------------------ */

export type SearchProviderName = 'none' | 'brave' | 'serper';

interface WebSearchOutcome {
  resultCount: number | null;
  mentions: ProminenceResult['mentions'];
  note?: string;
}

async function braveSearch(query: string, apiKey: string, userAgent: string): Promise<WebSearchOutcome> {
  try {
    const params = new URLSearchParams({ q: query, count: '10', country: 'nz', safesearch: 'moderate' });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'x-subscription-token': apiKey,
        accept: 'application/json',
        'user-agent': userAgent,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { resultCount: null, mentions: [], note: `Brave returned ${response.status}.` };

    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = body.web?.results ?? [];

    return {
      resultCount: results.length,
      mentions: results.slice(0, 6).map((result) => ({
        title: (result.title ?? '').slice(0, 200),
        url: (result.url ?? '').slice(0, 500),
        snippet: (result.description ?? '').replace(/<[^>]+>/g, '').slice(0, 400),
      })),
    };
  } catch (error) {
    return { resultCount: null, mentions: [], note: `Brave search failed: ${error}` };
  }
}

async function serperSearch(query: string, apiKey: string, userAgent: string): Promise<WebSearchOutcome> {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'user-agent': userAgent },
      body: JSON.stringify({ q: query, num: 10 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { resultCount: null, mentions: [], note: `Serper returned ${response.status}.` };

    const body = (await response.json()) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      searchInformation?: { totalResults?: string };
    };
    const organic = body.organic ?? [];
    const total = Number(body.searchInformation?.totalResults ?? '');

    return {
      resultCount: Number.isFinite(total) ? total : organic.length,
      mentions: organic.slice(0, 6).map((result) => ({
        title: (result.title ?? '').slice(0, 200),
        url: (result.link ?? '').slice(0, 500),
        snippet: (result.snippet ?? '').slice(0, 400),
      })),
    };
  } catch (error) {
    return { resultCount: null, mentions: [], note: `Serper search failed: ${error}` };
  }
}

export interface ProminenceOptions {
  userAgent: string;
  region?: string;
  provider?: SearchProviderName;
  apiKey?: string;
}

export async function checkProminence(
  businessName: string,
  options: ProminenceOptions,
): Promise<ProminenceResult> {
  const result: ProminenceResult = { ...EMPTY_PROMINENCE, checked: [], notes: [], mentions: [] };

  const wikidata = await lookupWikidata(businessName, options.userAgent);
  result.checked.push('wikidata');
  result.wikidataId = wikidata.wikidataId;
  result.wikidataLabel = wikidata.wikidataLabel;
  result.wikidataDescription = wikidata.wikidataDescription;
  if (wikidata.note) result.notes.push(wikidata.note);

  const provider = options.provider ?? 'none';
  if (provider !== 'none' && options.apiKey) {
    const query = options.region ? `"${businessName}" ${options.region}` : `"${businessName}"`;
    const search =
      provider === 'brave'
        ? await braveSearch(query, options.apiKey, options.userAgent)
        : await serperSearch(query, options.apiKey, options.userAgent);

    result.checked.push(provider);
    result.webResultCount = search.resultCount;
    result.mentions = search.mentions;
    if (search.note) result.notes.push(search.note);
  }

  return result;
}

/** Render for a prompt. Facts, plainly, with their source named. */
export function renderProminence(prominence: ProminenceResult): string {
  if (prominence.checked.length === 0) return '';

  const lines: string[] = [];

  if (prominence.wikidataId) {
    lines.push(
      `wikidata: ${prominence.wikidataId} — "${prominence.wikidataLabel}", ${prominence.wikidataDescription || 'no description'}`,
    );
    lines.push('(a catalogued entity — this is a business somebody considered notable)');
  } else {
    lines.push('wikidata: no entry, which is normal for an independent business');
  }

  if (prominence.webResultCount !== null) {
    lines.push(`web_results: about ${prominence.webResultCount}`);
  }

  if (prominence.mentions.length) {
    lines.push(
      'mentions:\n' +
        prominence.mentions
          .slice(0, 4)
          .map((m) => `  - ${m.title}`)
          .join('\n'),
    );
  }

  return lines.join('\n');
}
