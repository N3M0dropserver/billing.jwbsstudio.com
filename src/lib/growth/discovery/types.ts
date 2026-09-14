/**
 * Discovery: turning "coffee roasters in Wellington" into a list of real
 * businesses with enough detail to go and look at them.
 *
 * Providers are interchangeable and every one of them returns the same
 * shape. What differs is cost and terms, which is why the choice is a
 * setting rather than a hard-coded default.
 */

export type DiscoveryProviderName = 'overpass' | 'google-places' | 'manual';

export interface DiscoveryRequest {
  niche: string;
  region: string;
  country: 'NZ' | 'AU' | string;
  /** Upper bound on results. Providers may return fewer. */
  limit: number;
  /** Raw pasted input, for the `manual` provider. */
  manualInput?: string;
  /** Key for providers that need one. Absent means the provider is unusable. */
  apiKey?: string;
  /** Identifies us to public APIs that ask for it. */
  userAgent: string;
}

export interface DiscoveredBusiness {
  name: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  mapsUrl?: string;
  /** Free text the provider knows that might inform scoring. */
  context?: string;
  /** Which provider produced this, and its own id for the record. */
  source: DiscoveryProviderName;
  sourceRef: string;
  rating?: number;
  reviewCount?: number;

  /**
   * Chain membership, where the source knows it.
   *
   * OpenStreetMap tags a branch of a chain with `brand`, and a recognised
   * brand with `brand:wikidata`. Both are strong, free evidence that a
   * business is too large for an unsolicited spec redesign — throwing them
   * away is how a national roaster ends up on a freelancer's prospect list.
   */
  brand?: string;
  /** Wikidata id of the brand. Its presence alone means a known chain. */
  brandWikidata?: string;
  /** Who runs it, when that differs from the name. Franchise marker. */
  operator?: string;
  /** How many branches the search found in this region. */
  branchCount?: number;

  /**
   * Photographs the source holds of this business, as references to fetch
   * later rather than bytes.
   *
   * Discovery runs over dozens of businesses and most of them are discarded
   * before anything is built, so downloading their photography here would be
   * paying for pictures nobody will ever see. The reference is cheap to
   * carry; research redeems the handful that make the shortlist.
   *
   * For a business with no website at all — which is most of what this
   * pipeline selects — these are the only real photographs of them that
   * exist anywhere we can reach, and a demo built without them is a demo
   * built out of type alone.
   */
  photoRefs?: string[];

  /** What their customers said. Untrusted: it is public third-party text. */
  reviews?: ReviewQuote[];

  /** As the source states them, one entry per day. */
  openingHours?: string[];

  /** The source's own one-line description of the business. Untrusted. */
  summary?: string;
}

/** One review, kept whole so a testimonial can be attributed honestly. */
export interface ReviewQuote {
  quote: string;
  rating: number | null;
  author: string;
}

export interface DiscoveryOutcome {
  businesses: DiscoveredBusiness[];
  /** Anything the operator should know: partial results, quota, licensing. */
  notes: string[];
}

export type DiscoveryResult =
  | { ok: true; data: DiscoveryOutcome }
  | { ok: false; error: string };

export interface DiscoveryProvider {
  name: DiscoveryProviderName;
  label: string;
  /** Shown in the UI so the trade-off is visible at the point of choosing. */
  description: string;
  /** Why it might not be usable right now, or null when it is. */
  unavailableReason(request: DiscoveryRequest): string | null;
  run(request: DiscoveryRequest): Promise<DiscoveryResult>;
}
