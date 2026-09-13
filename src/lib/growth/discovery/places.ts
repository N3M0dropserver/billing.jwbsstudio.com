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
 * Set GOOGLE_PLACES_API_KEY to enable it.
 */

import type {
  DiscoveredBusiness,
  DiscoveryProvider,
  DiscoveryRequest,
  DiscoveryResult,
} from './types';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

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
  }>;
  error?: { message?: string; status?: string };
}

export const placesProvider: DiscoveryProvider = {
  name: 'google-places',
  label: 'Google Places',
  description:
    'Broadest coverage and carries ratings and review counts. Costs per request and its terms ' +
    'limit how long results may be kept — set GOOGLE_PLACES_API_KEY to turn it on.',

  unavailableReason(request) {
    if (!request.apiKey) {
      return 'GOOGLE_PLACES_API_KEY is not set. Add it as a Worker secret to use this provider.';
    }
    if (!request.niche.trim() || !request.region.trim()) {
      return 'Name a trade and a region.';
    }
    return null;
  },

  async run(request): Promise<DiscoveryResult> {
    if (!request.apiKey) {
      return { ok: false, error: 'GOOGLE_PLACES_API_KEY is not set.' };
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
      });

      if (collected.length >= request.limit) break;
    }

    if (collected.length === 0) {
      notes.push('Places had nothing for that phrasing. Try the words a customer would use.');
    }

    return { ok: true, data: { businesses: collected, notes } };
  },
};
