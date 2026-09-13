/**
 * Paste-in discovery.
 *
 * The escape hatch for a list you already have — a trade directory export, a
 * conference attendee list, three businesses down the road you keep meaning
 * to write to. Everything after this stage treats them identically to a
 * discovered result.
 *
 * One business per line. A name on its own is enough; a URL, an email or a
 * phone number anywhere on the line is picked up. Fields may also be
 * separated by commas or tabs, which is what a spreadsheet paste looks like.
 */

import type {
  DiscoveredBusiness,
  DiscoveryProvider,
  DiscoveryResult,
} from './types';

const URL_PATTERN = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;]*)?)/i;
const EMAIL_PATTERN = /\b[^\s,;<>@]+@[^\s,;<>@]+\.[a-z]{2,}\b/i;
const PHONE_PATTERN = /(\+?\d[\d\s().-]{6,}\d)/;

/** Parse one pasted line into a business, or null when there is no name left. */
export function parseManualLine(line: string, index: number): DiscoveredBusiness | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const email = trimmed.match(EMAIL_PATTERN)?.[0];
  // Take the email out before looking for a URL, or the domain in the address
  // is read as the website.
  const withoutEmail = email ? trimmed.replace(email, ' ') : trimmed;

  const urlMatch = withoutEmail.match(URL_PATTERN)?.[0];
  const withoutUrl = urlMatch ? withoutEmail.replace(urlMatch, ' ') : withoutEmail;

  const phone = withoutUrl.match(PHONE_PATTERN)?.[0]?.trim();
  const withoutPhone = phone ? withoutUrl.replace(phone, ' ') : withoutUrl;

  const name = withoutPhone
    .split(/[,\t;|]/)[0]!
    .replace(/\s+/g, ' ')
    .trim();

  if (!name) return null;

  const website = urlMatch
    ? urlMatch.startsWith('http')
      ? urlMatch
      : `https://${urlMatch}`
    : undefined;

  return {
    name,
    website,
    email,
    phone,
    source: 'manual',
    sourceRef: `line-${index + 1}`,
    context: 'Entered by hand.',
  };
}

export const manualProvider: DiscoveryProvider = {
  name: 'manual',
  label: 'Paste a list',
  description:
    'One business per line. A name is enough; a URL, email or phone anywhere on the line is ' +
    'picked up. Everything downstream treats them like any other prospect.',

  unavailableReason(request) {
    return request.manualInput?.trim() ? null : 'Paste at least one business.';
  },

  async run(request): Promise<DiscoveryResult> {
    const lines = (request.manualInput ?? '').split('\n');
    const businesses: DiscoveredBusiness[] = [];
    const seen = new Set<string>();

    for (const [index, line] of lines.entries()) {
      const business = parseManualLine(line, index);
      if (!business) continue;
      const key = business.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      businesses.push(business);
      if (businesses.length >= request.limit) break;
    }

    if (businesses.length === 0) {
      return { ok: false, error: 'Nothing in that paste looked like a business name.' };
    }

    const skipped = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length - businesses.length;
    const notes = skipped > 0 ? [`${skipped} line(s) were duplicates or had no name.`] : [];

    return { ok: true, data: { businesses, notes } };
  },
};
