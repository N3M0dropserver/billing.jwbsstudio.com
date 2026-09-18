/**
 * Google Places discovery, through the Places API (New) Text Search.
 *
 * Better coverage than OpenStreetMap for businesses without a shopfront,
 * and it carries ratings and review counts, which are a genuinely useful
 * signal about whether a business is alive and trading.
 *
 * It costs money per request and its terms constrain what you may keep:
 * place data may generally be cached for up to 30 days, and the place id is
 * the only field intended for indefinite storage. This app stores the name,
 * contact details and rating so a prospect list survives longer than a
 * session — that is a decision with terms attached, which is why this
 * provider is opt-in and the free one is the default.
 *
 * Set GOOGLE_PLACES_API_KEY to enable it — on **both** Workers. Discovery runs
 * inside the agent Worker (`jwbs-growth-agent`), and a Worker's secrets are its
 * own: a key set only on the app Worker leaves every run failing with "not
 * set" while the settings page cheerfully reports that it is.
 */

import type {
  DiscoveredBusiness,
  DiscoveryProvider,
  DiscoveryRequest,
  DiscoveryResult,
  ReviewQuote,
} from './types';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const MEDIA_ENDPOINT = 'https://places.googleapis.com/v1';

/**
 * Only the fields we actually use. Places bills by field mask, so asking for
 * less is not tidiness — it is the difference in the invoice.
 */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'places.googleMapsUri',
  // The fields that let a demo be built for a business with no website.
  // Photographs of the premises, what their customers actually said, and
  // the hours — which together are most of what a one-page site says.
  // They move this search into the Enterprise SKU, which is the trade
  // being made: a page with their own photography on it is the difference
  // between a concept and a template with a name dropped in.
  'places.photos',
  'places.reviews',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.editorialSummary',
].join(',');

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    primaryTypeDisplayName?: { text?: string };
    businessStatus?: string;
    googleMapsUri?: string;
    photos?: Array<{ name?: string; widthPx?: number; heightPx?: number }>;
    reviews?: Array<{
      rating?: number;
      text?: { text?: string };
      originalText?: { text?: string };
      authorAttribution?: { displayName?: string };
    }>;
    regularOpeningHours?: { weekdayDescriptions?: string[] };
    editorialSummary?: { text?: string };
  }>;
  error?: { message?: string; status?: string };
}

/** The most photographs worth carrying. The renderer places six at most. */
const MAX_PHOTOS = 8;

/** Pull the reviews out, longest first — a one-word review is not a quote. */
export function readReviews(
  raw: NonNullable<PlacesResponse['places']>[number]['reviews'],
): ReviewQuote[] {
  return (raw ?? [])
    .map((review) => ({
      quote: String(review.text?.text ?? review.originalText?.text ?? '').trim().slice(0, 600),
      rating: typeof review.rating === 'number' ? review.rating : null,
      author: String(review.authorAttribution?.displayName ?? '').trim().slice(0, 120),
    }))
    .filter((review) => review.quote.length >= 40)
    .sort((a, b) => b.quote.length - a.quote.length)
    .slice(0, 5);
}

export const placesProvider: DiscoveryProvider = {
  name: 'google-places',
  label: 'Google Places',
  description:
    'Broadest coverage and carries ratings and review counts. Costs per request and its terms ' +
    'limit how long results may be kept — set GOOGLE_PLACES_API_KEY to turn it on.',

  unavailableReason(request) {
    if (!request.apiKey) {
      return (
        'GOOGLE_PLACES_API_KEY is not set. It is a secret on each Worker separately — set it ' +
        'on the app Worker and on the agent Worker (`wrangler secret put GOOGLE_PLACES_API_KEY ' +
        '-c workers/agent/wrangler.jsonc`), which is where a run actually calls Places.'
      );
    }
    if (!request.niche.trim() || !request.region.trim()) {
      return 'Name a trade and a region.';
    }
    return null;
  },

  async run(request): Promise<DiscoveryResult> {
    if (!request.apiKey) {
      return {
        ok: false,
        error:
          'GOOGLE_PLACES_API_KEY is not set on this Worker. Secrets are per-Worker: setting it ' +
          'on the app Worker does not reach the agent Worker, which is what runs discovery. ' +
          'Run `wrangler secret put GOOGLE_PLACES_API_KEY -c workers/agent/wrangler.jsonc`.',
      };
    }

    const regionCode = request.country === 'AU' ? 'AU' : 'NZ';
    const collected: DiscoveredBusiness[] = [];
    const notes = [
      'Place data © Google. Its terms limit caching to 30 days for most fields.',
    ];

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': request.apiKey,
          'x-goog-fieldmask': FIELD_MASK,
          'user-agent': request.userAgent,
        },
        body: JSON.stringify({
          textQuery: `${request.niche} in ${request.region}`,
          regionCode,
          // Places caps a page at 20; ask for what we need and no more.
          pageSize: Math.max(1, Math.min(request.limit, 20)),
        }),
      });
    } catch (error) {
      return { ok: false, error: `Could not reach the Places API: ${String(error)}` };
    }

    let body: PlacesResponse;
    try {
      body = (await response.json()) as PlacesResponse;
    } catch {
      return { ok: false, error: `Places returned ${response.status} and no usable body.` };
    }

    if (!response.ok || body.error) {
      const detail = body.error?.message ?? `HTTP ${response.status}`;
      return { ok: false, error: `Places rejected the search: ${detail}` };
    }

    for (const place of body.places ?? []) {
      const name = place.displayName?.text?.trim();
      if (!name) continue;
      // A closed business is not a prospect.
      if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') continue;

      collected.push({
        name,
        website: place.websiteUri || undefined,
        phone: place.nationalPhoneNumber || place.internationalPhoneNumber || undefined,
        address: place.formattedAddress || undefined,
        mapsUrl: place.googleMapsUri || undefined,
        rating: typeof place.rating === 'number' ? place.rating : undefined,
        reviewCount:
          typeof place.userRatingCount === 'number' ? place.userRatingCount : undefined,
        context: [
          place.primaryTypeDisplayName?.text ?? '',
          typeof place.rating === 'number'
            ? `rated ${place.rating} from ${place.userRatingCount ?? 0} reviews`
            : 'no reviews',
        ]
          .filter(Boolean)
          .join('; '),
        source: 'google-places',
        sourceRef: place.id ?? name,
        photoRefs: (place.photos ?? [])
          .map((photo) => String(photo.name ?? ''))
          .filter(Boolean)
          .slice(0, MAX_PHOTOS),
        reviews: readReviews(place.reviews),
        openingHours: (place.regularOpeningHours?.weekdayDescriptions ?? [])
          .map((entry) => String(entry).slice(0, 80))
          .slice(0, 7),
        summary: String(place.editorialSummary?.text ?? '').slice(0, 600),
      });

      if (collected.length >= request.limit) break;
    }

    if (collected.length === 0) {
      notes.push('Places had nothing for that phrasing. Try the words a customer would use.');
    }

    return { ok: true, data: { businesses: collected, notes } };
  },
};


/* ------------------------------------------------------------------ */
/* Photographs                                                         */
/* ------------------------------------------------------------------ */

export interface PlacePhoto {
  body: ArrayBuffer;
  contentType: string;
  /** Where it came from, for the record kept against the prospect. */
  sourceUrl: string;
}

/**
 * The URL that returns the bytes of one Places photo.
 *
 * `skipHttpRedirect` is deliberately not set: the media endpoint answers a
 * plain GET with a redirect to the image itself, and `fetch` follows it, so
 * there is no second round trip to get the JSON and then the picture.
 */
export function placePhotoUrl(photoRef: string, apiKey: string, maxWidthPx = 1600): string {
  const ref = photoRef.replace(/^\/+/, '');
  return `${MEDIA_ENDPOINT}/${ref}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`;
}

/**
 * Fetch one photograph.
 *
 * Google's terms require place photos to be shown with attribution and not
 * stored indefinitely, which is why what comes back is labelled with its
 * source and lives against a prospect rather than in a general image library.
 *
 * Returns null rather than throwing: a picture that will not download is a
 * page with one fewer picture, never a failed run.
 */
export async function fetchPlacePhoto(
  photoRef: string,
  apiKey: string,
  options: { userAgent: string; maxBytes?: number; maxWidthPx?: number },
): Promise<PlacePhoto | null> {
  const url = placePhotoUrl(photoRef, apiKey, options.maxWidthPx);

  try {
    const response = await fetch(url, { headers: { 'user-agent': options.userAgent } });
    if (!response.ok) return null;

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!contentType.startsWith('image/')) return null;

    const body = await response.arrayBuffer();
    if (body.byteLength === 0) return null;
    if (body.byteLength > (options.maxBytes ?? 4_000_000)) return null;

    return {
      body,
      contentType,
      // The key is stripped: this string is stored against the prospect and
      // shown in the app, and an API key must not travel with it.
      sourceUrl: `${MEDIA_ENDPOINT}/${photoRef.replace(/^\/+/, '')}/media`,
    };
  } catch {
    return null;
  }
}
