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
