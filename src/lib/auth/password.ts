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
 * ## The 100,000 iteration ceiling
 *
 * Workers refuse a single PBKDF2 call above 100,000 iterations outright:
 *
 *     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are
 *     not supported (requested 600000).
 *
 * Node has no such cap, which is a trap — `scripts/add-user.mjs` runs under
 * Node and would write a hash the Worker then cannot evaluate. That is not a
 * hypothetical: it is what happened, and because the error surfaced through a
 * `catch { return false }` it presented as "wrong password" on every attempt.
 *
 * So the work factor is reached by chaining rounds that each sit on the
 * ceiling: six rounds of 100,000, the output of one seeding the next over the
 * same salt. The attacker's cost is the same 600,000 HMAC-SHA256 iterations.
 * It is not literally PBKDF2-600k — each round re-imports key material — so
 * the stored format names the shape rather than a single total.
 *
 *     pbkdf2$<rounds>x<iterations per round>$<salt base64>$<hash base64>
 *
 * A bare integer in the second field is the older single-pass layout. Those
 * still verify when they are under the ceiling, and are reported as
 * `unsupported` rather than silently failing when they are over it.
 *
 * Anything changed here must be changed identically in scripts/add-user.mjs,
 * which reimplements it for Node. tests/password.test.ts pins the two
 * together by verifying a hash produced by the script's own algorithm.
 */

/** What a single WebCrypto PBKDF2 call may request on Workers. */
export const MAX_ITERATIONS_PER_CALL = 100_000;

const ROUNDS = 6;
const ITERATIONS_PER_ROUND = 100_000;
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

/**
 * `rounds` chained PBKDF2 passes of `iterations` each, over one salt.
 *
 * Round one takes the password; every later round takes the previous round's
 * output as its key material.
 */
async function derive(
  password: string,
  salt: Uint8Array,
  rounds: number,
  iterations: number,
): Promise<Uint8Array> {
  let material: Uint8Array = new TextEncoder().encode(password);

  for (let round = 0; round < rounds; round++) {
    const key = await crypto.subtle.importKey(
      'raw',
      material as BufferSource,
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      key,
      KEY_LENGTH_BITS,
    );
    material = new Uint8Array(bits);
  }

  return material;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, ROUNDS, ITERATIONS_PER_ROUND);
  return `pbkdf2$${ROUNDS}x${ITERATIONS_PER_ROUND}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Constant-time comparison, so a wrong password cannot be timed out byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

interface ParsedHash {
  rounds: number;
  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

type ParseResult = { ok: true; parsed: ParsedHash } | { ok: false; detail: string };

function parseStored(stored: string): ParseResult {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return { ok: false, detail: 'Not a pbkdf2 hash in the expected four-field layout.' };
  }

  const work = parts[1]!;
  let rounds: number;
  let iterations: number;

  const chained = /^(\d+)x(\d+)$/.exec(work);
  if (chained) {
    rounds = Number.parseInt(chained[1]!, 10);
    iterations = Number.parseInt(chained[2]!, 10);
  } else if (/^\d+$/.test(work)) {
    // The older single-pass layout.
    rounds = 1;
    iterations = Number.parseInt(work, 10);
  } else {
    return { ok: false, detail: `Unrecognised work factor "${work}".` };
  }

  if (!Number.isFinite(rounds) || rounds < 1 || !Number.isFinite(iterations) || iterations < 1) {
    return { ok: false, detail: `Nonsensical work factor "${work}".` };
  }

  if (iterations > MAX_ITERATIONS_PER_CALL) {
    return {
      ok: false,
      detail:
        `This hash asks for ${iterations} PBKDF2 iterations in one call, and Workers refuse ` +
        `anything above ${MAX_ITERATIONS_PER_CALL}. It was almost certainly written by an older ` +
        `scripts/add-user.mjs running under Node, which has no such limit, so it can never be ` +
        `verified here. Reset the password — a sign-in link will get you in to do it.`,
    };
  }

  try {
    return {
      ok: true,
      parsed: { rounds, iterations, salt: fromBase64(parts[2]!), expected: fromBase64(parts[3]!) },
    };
  } catch (error) {
    return { ok: false, detail: `Salt or hash is not valid base64: ${String(error)}` };
  }
}

/**
 * Why a password check came out the way it did.
 *
 * `mismatch` is the only one that means "wrong password". The rest mean the
 * stored hash could not be evaluated at all, which is an operator problem and
 * must not be reported to the user — or counted against them — as a failed
 * attempt. Conflating the two is what made the original outage invisible.
 */
export type VerifyReason = 'match' | 'mismatch' | 'unsupported' | 'error';

export interface VerifyResult {
  ok: boolean;
  reason: VerifyReason;
  /** Operator-facing explanation. Safe to log, never shown to the user. */
  detail?: string;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parsed = parseStored(stored);
  if (!parsed.ok) return { ok: false, reason: 'unsupported', detail: parsed.detail };

  const { rounds, iterations, salt, expected } = parsed.parsed;

  try {
    const actual = await derive(password, salt, rounds, iterations);
    return timingSafeEqual(actual, expected)
      ? { ok: true, reason: 'match' }
      : { ok: false, reason: 'mismatch' };
  } catch (error) {
    // Never collapse this into "wrong password" again.
    return { ok: false, reason: 'error', detail: String(error) };
  }
}

/** True when a hash was made with a weaker work factor than we now use. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  if (!parsed.ok) return true;
  const { rounds, iterations } = parsed.parsed;
  return rounds * iterations < ROUNDS * ITERATIONS_PER_ROUND;
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
