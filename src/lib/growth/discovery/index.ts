/**
 * The discovery registry.
 *
 * One interface, three providers, chosen per campaign. Adding a fourth means
 * writing a module that satisfies `DiscoveryProvider` and adding it to the
 * list below — nothing downstream needs to know.
 */

import { overpassProvider } from './overpass';
import { placesProvider } from './places';
import { manualProvider } from './manual';
import type {
  DiscoveryProvider,
  DiscoveryProviderName,
  DiscoveryRequest,
  DiscoveryResult,
} from './types';

export * from './types';
export { overpassProvider, placesProvider, manualProvider };
export { buildOverpassQuery, filtersForNiche, escapeOverpassRegex } from './overpass';
export { parseManualLine } from './manual';

export const PROVIDERS: DiscoveryProvider[] = [overpassProvider, placesProvider, manualProvider];

/** Narrow an arbitrary form value to a provider name. */
export function toProviderName(value: unknown): DiscoveryProviderName | null {
  return PROVIDERS.some((provider) => provider.name === value)
    ? (value as DiscoveryProviderName)
    : null;
}

export function getProvider(name: DiscoveryProviderName): DiscoveryProvider {
  return PROVIDERS.find((p) => p.name === name) ?? overpassProvider;
}

/**
 * Identify ourselves to public APIs.
 *
 * Nominatim and Overpass both ask for a User-Agent that names the
 * application and gives them a way to get in touch before they resort to
 * blocking. Sending a real one is the price of using donated infrastructure.
 */
export function discoveryUserAgent(appUrl: string): string {
  return `JWBSStudioGrowth/1.0 (+${appUrl})`;
}

export async function discover(
  name: DiscoveryProviderName,
  request: DiscoveryRequest,
): Promise<DiscoveryResult> {
  const provider = getProvider(name);
  const unavailable = provider.unavailableReason(request);
  if (unavailable) return { ok: false, error: unavailable };

  try {
    return await provider.run(request);
  } catch (error) {
    return { ok: false, error: `${provider.label} discovery failed: ${String(error)}` };
  }
}
