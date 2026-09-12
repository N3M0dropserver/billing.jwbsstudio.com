/**
 * The password hashing algorithm, for Node.
 *
 * This is a deliberate duplicate of `src/lib/auth/password.ts`, which cannot
 * be imported here: that file is TypeScript compiled for the Worker bundle,
 * and this runs as plain Node under `npm run user:add`.
 *
 * The duplication is the dangerous part, so it is pinned by a test —
 * `tests/password.test.ts` hashes with THIS module and verifies with the
 * app's implementation. If the two drift, that test fails.
 *
 * Why the odd shape: Node's WebCrypto will do 600,000 PBKDF2 iterations in a
 * single call, and Cloudflare Workers will not. Workers throw outright above
 * 100,000:
 *
 *     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are
 *     not supported (requested 600000).
 *
 * A hash written here with one large count is therefore one the app can never
 * verify, and the failure surfaces as "wrong password" on every attempt with
 * nothing to indicate otherwise. So the work factor is reached by chaining
 * rounds that each sit on the Workers ceiling.
 */

import { webcrypto as crypto } from 'node:crypto';

export const ROUNDS = 6;
export const ITERATIONS_PER_ROUND = 100_000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

async function derive(password, salt, rounds, iterations) {
  let material = new TextEncoder().encode(password);
  for (let round = 0; round < rounds; round++) {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      KEY_LENGTH_BITS,
    );
    material = new Uint8Array(bits);
  }
  return material;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ROUNDS, ITERATIONS_PER_ROUND);
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  return `pbkdf2$${ROUNDS}x${ITERATIONS_PER_ROUND}$${b64(salt)}$${b64(hash)}`;
}

export function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
