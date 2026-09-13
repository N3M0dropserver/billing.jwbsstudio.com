/**
 * Reading an email open.
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
 * The pixel itself — its bytes, its URL and the response that serves it —
 * lives in src/lib/mail/tracking.ts, which is where every sent email gets one.
 * What is left here is the part this log cares about: telling a proxy's fetch
 * from a person's.
 */

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
