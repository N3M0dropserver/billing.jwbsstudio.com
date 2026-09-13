/**
 * Open tracking.
 *
 * A 1×1 transparent GIF on a per-send URL. When a mail client loads it, we
 * learn the message was rendered somewhere.
 *
 * Read the resulting numbers with suspicion, and never build logic on them:
 *
 *  - Apple Mail Privacy Protection fetches every image in every message the
 *    moment it arrives, read or not, from an Apple relay. That is an "open"
 *    that never happened, and it is a large share of consumer mail.
 *  - Gmail proxies images through googleusercontent.com and caches them. The
 *    first load registers; subsequent re-opens usually do not. The IP and user
 *    agent belong to Google, not the recipient.
 *  - Outlook and most corporate clients block remote images by default, so a
 *    genuine, careful read can record nothing at all.
 *
 * The signal that actually means something is the client following the link:
 * /pay/<token> stamps invoices.viewed_at, and that is what moves an invoice to
 * "viewed". This file produces a softer, noisier hint that sits beside it.
 */

/** A 1×1 fully transparent GIF — the smallest thing a mail client will fetch. */
const PIXEL_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function pixelBytes(): Uint8Array {
  const binary = atob(PIXEL_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pixelUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/e/${encodeURIComponent(token)}.gif`;
}

/**
 * Append the pixel to a rendered HTML body.
 *
 * Placed last, sized 1×1, with empty alt text so a screen reader skips it and
 * a client showing broken-image placeholders shows nothing.
 */
export function withTrackingPixel(html: string, url: string): string {
  const img =
    `<img src="${url}" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;opacity:0" />`;

  const closing = html.lastIndexOf('</body>');
  if (closing === -1) return html + img;
  return html.slice(0, closing) + img + html.slice(closing);
}

/**
 * User agents belonging to scanners and prefetchers rather than people.
 *
 * Not exhaustive and never will be — it downgrades the confidence of an open,
 * it does not gate recording one.
 */
const PREFETCH_AGENTS =
  /GoogleImageProxy|YahooMailProxy|Barracuda|Proofpoint|Mimecast|Symantec|MessageLabs|bot\b|crawler|spider|preview/i;

/**
 * Whether a hit looks automated rather than human.
 *
 * Two tells: a recognised scanner user agent, or a fetch arriving so soon
 * after sending that nobody could plausibly have opened it yet.
 */
export function looksLikePrefetch(
  userAgent: string | null,
  sentAt: string,
  now: number = Date.now(),
): boolean {
  if (userAgent && PREFETCH_AGENTS.test(userAgent)) return true;

  const elapsed = now - new Date(sentAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 10_000;
}
