/**
 * Email open tracking.
 *
 * An invoice email carries a 1×1 transparent GIF whose URL names the send it
 * belongs to. When a mail client loads remote images, the Worker sees the
 * request and writes an `email-opened` event against that send — so a
 * reminder's open is distinguishable from the original invoice's.
 *
 * Read the caveats before trusting a row:
 *
 *  - Most mail clients block remote images by default. No open event does not
 *    mean the mail was not read.
 *  - Apple Mail Privacy Protection pre-fetches every image through a proxy
 *    whether or not the message is opened, as do plenty of corporate scanners.
 *    An open event does not mean a human looked at it.
 *  - A forwarded email opened by someone else still logs against the original
 *    send.
 *
 * A web invoice view is far better evidence than an email open, and a PDF
 * download better still. The pixel is a weak signal offered as a weak signal,
 * and it can be switched off entirely in Settings.
 *
 * The URL carries no address and no name — only the invoice's existing public
 * token and the id of the send event, both already random. Anyone who can see
 * the pixel URL could already open the invoice itself, so it leaks nothing new.
 */

/**
 * The smallest valid GIF: 1×1, one transparent pixel, 42 bytes. Decoded once
 * at module load rather than at request time.
 */
const TRANSPARENT_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const TRANSPARENT_GIF: Uint8Array = Uint8Array.from(
  atob(TRANSPARENT_GIF_BASE64),
  (character) => character.charCodeAt(0),
);

/**
 * Where the pixel for one send lives.
 *
 * `sendEventId` is the id of the `sent` or `reminder-sent` event, generated
 * before the row is written so it can go into the email body.
 */
export function trackingPixelUrl(
  baseUrl: string,
  publicToken: string,
  sendEventId: string,
): string {
  return `${baseUrl.replace(/\/+$/, '')}/t/${encodeURIComponent(publicToken)}/${encodeURIComponent(sendEventId)}.gif`;
}

/**
 * The response every pixel request gets, hit or miss.
 *
 * Always the same image and always a 200: a 404 for an unknown token would
 * tell a scraper which tokens exist, and a broken-image icon in an invoice
 * email looks like a mistake to the client. Caching is refused outright, or
 * the second open would never reach us.
 */
export function pixelResponse(): Response {
  return new Response(TRANSPARENT_GIF as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Mail-provider proxies that fetch images on the recipient's behalf. Recorded
 * on the event so a row that came through one can be read with due suspicion
 * rather than silently dropped — Gmail proxies every image, and dropping
 * those would throw away the opens of every Gmail user.
 */
const PROXY_PATTERNS: Array<[RegExp, string]> = [
  [/GoogleImageProxy/i, 'Gmail image proxy'],
  [/YahooMailProxy/i, 'Yahoo Mail proxy'],
  [/Barracuda|Proofpoint|Mimecast|Symantec|MessageLabs/i, 'mail security scanner'],
  [/Microsoft Office|SkypeUriPreview|BingPreview/i, 'Microsoft link preview'],
];

/** The proxy a pixel request came through, if it is a recognisable one. */
export function identifyProxy(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  for (const [pattern, name] of PROXY_PATTERNS) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}
