/**
 * Password hashing with PBKDF2-SHA256 via WebCrypto.
 *
 * Why PBKDF2 and not argon2id or bcrypt: Workers give you the WebCrypto
 * SubtleCrypto implementation natively, and it runs in optimised native code.
 * argon2/bcrypt would mean shipping a WASM build, adding hundreds of
 * kilobytes to the bundle and burning CPU time against the Workers limit.
 * PBKDF2 with a high iteration count is the right trade here, and OWASP
 * still considers it acceptable at 600,000+ iterations for SHA-256.
 *
 * The stored format is self-describing so the iteration count can be raised
 * later without invalidating existing hashes:
 *
 *     pbkdf2$<iterations>$<salt base64>$<hash base64>
 */

const ITERATIONS = 600_000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Constant-time comparison, so a wrong password cannot be timed out byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  try {
    const salt = fromBase64(parts[2]!);
    const expected = fromBase64(parts[3]!);
    const actual = await derive(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a hash was made with fewer iterations than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return true;
  const iterations = Number.parseInt(parts[1]!, 10);
  return !Number.isFinite(iterations) || iterations < ITERATIONS;
}

export interface PasswordStrength {
  ok: boolean;
  problems: string[];
}

export function checkPasswordStrength(password: string): PasswordStrength {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Use at least 12 characters.');
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter.');
  if (!/[0-9]/.test(password)) problems.push('Include a digit.');
  if (/^(password|letmein|qwerty|12345)/i.test(password)) {
    problems.push('That is one of the most guessed passwords in existence.');
  }
  return { ok: problems.length === 0, problems };
}
