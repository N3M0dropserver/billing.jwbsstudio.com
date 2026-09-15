/**
 * Researching a business that has no website.
 *
 * This is not the edge case. The pipeline selects for a weak web presence and
 * the weakest is no site at all, so most of what reaches the build stage is a
 * maps listing — and a maps listing used to mean research learnt nothing,
 * stored no photographs, and handed the planner a name and a suburb to write
 * a page out of.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichProspect, summariseReviews } from '~/lib/growth/enrich';
import { placePhotoUrl, readReviews } from '~/lib/growth/discovery/places';

/** An R2 bucket that remembers what it was handed. */
function fakeBucket() {
  const stored = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    stored,
    async put(key: string, body: Uint8Array, options: { httpMetadata?: { contentType?: string } }) {
      stored.set(key, { body, contentType: options?.httpMetadata?.contentType ?? '' });
    },
  } as unknown as R2Bucket & { stored: Map<string, { body: Uint8Array; contentType: string }> };
}

function imageResponse(bytes = 2048): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readReviews', () => {
  it('keeps the substantial ones, longest first, with their author', () => {
    const reviews = readReviews([
      { rating: 5, text: { text: 'Great' }, authorAttribution: { displayName: 'A' } },
      {
        rating: 4,
        text: { text: 'The flat white is the best in Darlinghurst and they remember your order.' },
        authorAttribution: { displayName: 'Priya' },
      },
      {
        rating: 5,
        text: { text: 'Tiny room, enormous sandwiches, and the queue moves fast.' },
        authorAttribution: { displayName: 'Tom' },
      },
    ]);

    // "Great" is not a quote.
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.author).toBe('Priya');
    expect(reviews[0]?.quote).toContain('Darlinghurst');
  });

  it('falls back to the original text when there is no translation', () => {
    const reviews = readReviews([
      { originalText: { text: 'A long enough review to be worth quoting on a page.' } },
    ]);
    expect(reviews[0]?.quote).toContain('worth quoting');
  });

  it('handles a place with no reviews at all', () => {
    expect(readReviews(undefined)).toEqual([]);
  });
});

describe('summariseReviews', () => {
  it('leads with the rating and then quotes', () => {
    const summary = summariseReviews(
      [{ quote: 'Best coffee on the street.', rating: 5, author: 'Tom' }],
      4.7,
      210,
    );
    expect(summary).toBe('Rated 4.7 across 210 reviews. Best coffee on the street.');
  });

  it('falls back to the rating when there is nothing to quote', () => {
    expect(summariseReviews([], 4.7, 210)).toBe('Rated 4.7 across 210 reviews.');
  });

  it('says nothing rather than something empty', () => {
    expect(summariseReviews([], null, 0)).toBe('');
  });

  it('does not repeat the same quote twice', () => {
    const summary = summariseReviews(
      [
        { quote: 'Same words.', rating: null, author: '' },
        { quote: 'Same words.', rating: null, author: '' },
      ],
      null,
      0,
    );
    expect(summary).toBe('Same words.');
  });
});

describe('placePhotoUrl', () => {
  it('builds the media URL for a photo reference', () => {
    const url = placePhotoUrl('places/abc/photos/xyz', 'secret-key', 1200);
    expect(url).toBe(
      'https://places.googleapis.com/v1/places/abc/photos/xyz/media?maxWidthPx=1200&key=secret-key',
    );
  });
});

describe('enriching a prospect with no website', () => {
  it('fetches and stores the photographs the directory holds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse()));
    const bucket = fakeBucket();

    const enrichment = await enrichProspect(
      bucket,
      'growth/u1/c1/p1',
      { name: 'Meryenda', rating: 4.8, reviewCount: 120 },
      {
        userAgent: 'test',
        photoRefs: ['places/a/photos/1', 'places/a/photos/2'],
        placesApiKey: 'secret-key',
      },
    );

    expect(enrichment.imageObjects).toHaveLength(2);
    expect([...bucket.stored.keys()]).toEqual([
      'growth/u1/c1/p1/images/directory-00.jpg',
      'growth/u1/c1/p1/images/directory-01.jpg',
    ]);
  });

  /** An API key in a column is an API key in a screenshot. */
  it('records where a photograph came from without the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse()));

    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      { name: 'Meryenda' },
      { userAgent: 'test', photoRefs: ['places/a/photos/1'], placesApiKey: 'secret-key' },
    );

    expect(enrichment.imageObjects[0]?.sourceUrl).not.toContain('secret-key');
    expect(enrichment.imageObjects[0]?.sourceUrl).toContain('places/a/photos/1');
  });

  it('writes the directory facts up as something the planner can read', async () => {
    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      {
        name: 'Meryenda',
        rating: 4.8,
        reviewCount: 120,
        summary: 'Filipino bakery and cafe.',
        openingHours: ['Monday: 7am–3pm', 'Tuesday: 7am–3pm'],
        reviews: [{ quote: 'The ube pandesal sells out by ten.', rating: 5, author: 'Ana' }],
      },
      { userAgent: 'test' },
    );

    expect(enrichment.directoryContent).toContain('Filipino bakery');
    expect(enrichment.directoryContent).toContain('Monday: 7am–3pm');
    expect(enrichment.directoryContent).toContain('ube pandesal');
    expect(enrichment.directoryContent).toContain('Ana');
    expect(enrichment.openingHours).toHaveLength(2);
    expect(enrichment.reviewSummary).toContain('ube pandesal');

    // Their own copy is a different thing and stays empty: there is no site.
    expect(enrichment.siteContent).toBe('');
  });

  it('says so when there are photographs it has no key to fetch', async () => {
    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      { name: 'Meryenda' },
      { userAgent: 'test', photoRefs: ['places/a/photos/1'] },
    );

    expect(enrichment.imageObjects).toEqual([]);
    expect(enrichment.notes.join(' ')).toContain('GOOGLE_PLACES_API_KEY');
  });

  it('is a page with one fewer picture when a photograph will not download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));

    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      { name: 'Meryenda' },
      { userAgent: 'test', photoRefs: ['places/a/photos/1'], placesApiKey: 'k' },
    );

    expect(enrichment.imageObjects).toEqual([]);
    expect(enrichment.notes.join(' ')).toContain('None of the directory photographs could be downloaded');
  });

  it('refuses anything that is not an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    );

    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      { name: 'Meryenda' },
      { userAgent: 'test', photoRefs: ['places/a/photos/1'], placesApiKey: 'k' },
    );

    expect(enrichment.imageObjects).toEqual([]);
  });

  it('still reports honestly when there is nothing anywhere', async () => {
    const enrichment = await enrichProspect(
      fakeBucket(),
      'p',
      { name: 'Meryenda' },
      { userAgent: 'test' },
    );

    expect(enrichment.notes.join(' ')).toContain('No website');
    expect(enrichment.directoryContent).toBe('');
  });
});
