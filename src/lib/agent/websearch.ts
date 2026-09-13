/**
 * Web search as a tool.
 *
 * `src/lib/growth/search.ts` already asks a search engine one narrow
 * question: is this business famous enough that a cold concept site would be
 * an imposition? This is the general form of the same call, for an agent that
 * has been asked something open-ended — what a trade's good sites look like,
 * whether a business has been in the news, who actually owns the place.
 *
 * Three providers, in the order you would reach for them:
 *
 *   brave / serper — real web search, behind the same SEARCH_API_KEY the
 *                    prominence check already uses. Nothing new to set up if
 *                    that is configured, and nothing lost if it is not.
 *   wikipedia      — free, no key, and genuinely the best answer for "what
 *                    is this place" questions about towns, trades and
 *                    institutions. Always available, so the agent is never
 *                    completely blind.
 *
 * Results are other people's text. They are handed to the model inside a
 * fenced block, labelled as untrusted, and never executed or reflected into
 * a page we serve.
 */

export type SearchProviderName = 'none' | 'brave' | 'serper';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Which provider produced it, so a citation can say where it came from. */
  source: string;
}

export interface SearchOutcome {
  ok: boolean;
  provider: string;
  hits: SearchHit[];
  /** Roughly how much exists on this, when the provider reports it. */
  totalResults: number | null;
  error: string;
  elapsedMs: number;
}

export interface SearchOptions {
  provider?: SearchProviderName;
  apiKey?: string;
  userAgent: string;
  count?: number;
  /** Two-letter country hint, where the provider takes one. */
  country?: string;
}

export async function webSearch(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const started = Date.now();
  const trimmed = query.trim().slice(0, 300);
  if (!trimmed) {
    return { ok: false, provider: 'none', hits: [], totalResults: null, error: 'Empty query.', elapsedMs: 0 };
  }

  const provider = options.provider ?? 'none';
  const count = Math.min(Math.max(options.count ?? 8, 1), 20);

  if (provider !== 'none' && options.apiKey) {
    const outcome =
      provider === 'brave'
        ? await braveSearch(trimmed, options.apiKey, options, count)
        : await serperSearch(trimmed, options.apiKey, options, count);

    // A provider that is down should not leave the agent with nothing at all.
    if (outcome.ok && outcome.hits.length) return { ...outcome, elapsedMs: Date.now() - started };

    const fallback = await wikipediaSearch(trimmed, options.userAgent, count);
    return {
      ...fallback,
      error: outcome.error ? `${outcome.error} Fell back to Wikipedia.` : fallback.error,
      elapsedMs: Date.now() - started,
    };
  }

  const fallback = await wikipediaSearch(trimmed, options.userAgent, count);
  return { ...fallback, elapsedMs: Date.now() - started };
}

async function braveSearch(
  query: string,
  apiKey: string,
  options: SearchOptions,
  count: number,
): Promise<SearchOutcome> {
  try {
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      country: (options.country ?? 'nz').toLowerCase(),
      safesearch: 'moderate',
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'x-subscription-token': apiKey,
        accept: 'application/json',
        'user-agent': options.userAgent,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      return blank('brave', `Brave returned ${response.status}.`);
    }

    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = body.web?.results ?? [];

    return {
      ok: true,
      provider: 'brave',
      totalResults: results.length,
      error: '',
      elapsedMs: 0,
      hits: results.slice(0, count).map((result) => ({
        title: (result.title ?? '').slice(0, 200),
        url: (result.url ?? '').slice(0, 500),
        snippet: (result.description ?? '').replace(/<[^>]+>/g, '').slice(0, 500),
        source: 'brave',
      })),
    };
  } catch (error) {
    return blank('brave', `Brave search failed: ${error}`);
  }
}

async function serperSearch(
  query: string,
  apiKey: string,
  options: SearchOptions,
  count: number,
): Promise<SearchOutcome> {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'user-agent': options.userAgent,
      },
      body: JSON.stringify({ q: query, num: count }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) return blank('serper', `Serper returned ${response.status}.`);

    const body = (await response.json()) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      searchInformation?: { totalResults?: string };
    };

    const organic = body.organic ?? [];
    const total = Number(body.searchInformation?.totalResults ?? '');

    return {
      ok: true,
      provider: 'serper',
      totalResults: Number.isFinite(total) ? total : organic.length,
      error: '',
      elapsedMs: 0,
      hits: organic.slice(0, count).map((result) => ({
        title: (result.title ?? '').slice(0, 200),
        url: (result.link ?? '').slice(0, 500),
        snippet: (result.snippet ?? '').slice(0, 500),
        source: 'serper',
      })),
    };
  } catch (error) {
    return blank('serper', `Serper search failed: ${error}`);
  }
}

/**
 * The keyless path.
 *
 * Not a web search and not pretending to be one: it searches one
 * encyclopaedia. For "what is the main trade in Greymouth" that is a better
 * answer than a page of directory spam, and for "has this café been
 * reviewed" it is no answer at all — which the agent is told, so it does not
 * mistake silence for evidence.
 */
export async function wikipediaSearch(
  query: string,
  userAgent: string,
  count: number,
): Promise<SearchOutcome> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.min(count, 10)),
    format: 'json',
    origin: '*',
  });

  try {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return blank('wikipedia', `Wikipedia returned ${response.status}.`);

    const body = (await response.json()) as {
      query?: {
        search?: Array<{ title?: string; snippet?: string; pageid?: number }>;
        searchinfo?: { totalhits?: number };
      };
    };

    const results = body.query?.search ?? [];

    return {
      ok: true,
      provider: 'wikipedia',
      totalResults: body.query?.searchinfo?.totalhits ?? results.length,
      error: '',
      elapsedMs: 0,
      hits: results.map((result) => ({
        title: (result.title ?? '').slice(0, 200),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent((result.title ?? '').replace(/ /g, '_'))}`,
        snippet: (result.snippet ?? '').replace(/<[^>]+>/g, '').slice(0, 500),
        source: 'wikipedia',
      })),
    };
  } catch (error) {
    return blank('wikipedia', `Wikipedia search failed: ${error}`);
  }
}

function blank(provider: string, error: string): SearchOutcome {
  return { ok: false, provider, hits: [], totalResults: null, error, elapsedMs: 0 };
}

/** Search results as the model sees them: numbered, quoted, attributed. */
export function renderResults(outcome: SearchOutcome): string {
  if (!outcome.hits.length) {
    return outcome.error || `No results from ${outcome.provider}.`;
  }

  const lines = outcome.hits.map(
    (hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`,
  );

  return `${outcome.hits.length} result(s) from ${outcome.provider}:\n${lines.join('\n')}`;
}
