/**
 * Sortable, collision-resistant ids.
 *
 * A ULID-style layout: 48 bits of millisecond timestamp in Crockford base32
 * followed by 80 bits of randomness. Ids sort lexically by creation time,
 * which makes "most recent first" a plain ORDER BY on the primary key and
 * keeps SQLite's B-tree inserts appending rather than splitting.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U

function encodeTime(now: number, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    out = ALPHABET[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export function newId(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

/** A prefixed id, e.g. `inv_01J...`, for ids that show up in URLs or logs. */
export function newPrefixedId(prefix: string): string {
  return `${prefix}_${newId()}`;
}

/** URL-safe random token for public invoice and proposal links. */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
