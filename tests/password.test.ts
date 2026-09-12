import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  checkPasswordStrength,
  MAX_ITERATIONS_PER_CALL,
} from '~/lib/auth/password';
// The Node-side implementation used by `npm run user:add`. Importing it here
// is the whole point of this file — the two must not drift.
import { hashPassword as nodeHashPassword, generatePassword } from '../scripts/pbkdf2.mjs';

const WORK_FACTOR = /^pbkdf2\$(\d+)x(\d+)\$/;

describe('the Workers PBKDF2 ceiling', () => {
  /**
   * The bug this whole file exists for: Workers reject a single PBKDF2 call
   * above 100,000 iterations with NotSupportedError, Node does not, and a
   * hash written by the Node script at 600,000 could never be verified by
   * the app. It presented as "wrong password" forever.
   */
  it('never asks for more iterations in one call than Workers allow', async () => {
    for (const stored of [await hashPassword('correct horse battery staple'), await nodeHashPassword('correct horse battery staple')]) {
      const match = WORK_FACTOR.exec(stored);
      expect(match, `work factor not in the "<rounds>x<iterations>" form: ${stored}`).not.toBeNull();
      expect(Number(match![2])).toBeLessThanOrEqual(MAX_ITERATIONS_PER_CALL);
    }
  });

  it('still reaches a 600,000 iteration work factor overall', async () => {
    const match = WORK_FACTOR.exec(await hashPassword('correct horse battery staple'))!;
    expect(Number(match[1]) * Number(match[2])).toBe(600_000);
  });

  it('reports a hash it cannot evaluate as unsupported, not as a wrong password', async () => {
    // Exactly what the old scripts/add-user.mjs wrote.
    const legacy = 'pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const result = await verifyPassword('anything', legacy);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(result.reason).not.toBe('mismatch');
    expect(result.detail).toMatch(/100000/);
  });

  it('still verifies an older single-pass hash that is under the ceiling', async () => {
    // Nothing wrote these, but the format is accepted, so prove it works
    // rather than leaving a silent trapdoor.
    const { webcrypto } = await import('node:crypto');
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('under-the-cap'), 'PBKDF2', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 50_000, hash: 'SHA-256' }, key, 256);
    const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64');
    const stored = `pbkdf2$50000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

    expect((await verifyPassword('under-the-cap', stored)).ok).toBe(true);
    expect((await verifyPassword('wrong', stored)).reason).toBe('mismatch');
    expect(needsRehash(stored)).toBe(true);
  });
});

describe('scripts/add-user.mjs and the app agree', () => {
  it('verifies a hash the Node script produced', async () => {
    const password = generatePassword();
    const stored = await nodeHashPassword(password);

    const result = await verifyPassword(password, stored);
    expect(result.ok, `app could not verify a script-made hash: ${result.detail}`).toBe(true);
    expect(result.reason).toBe('match');
  });

  it('produces the identical stored format on both sides', async () => {
    const app = await hashPassword('x');
    const script = await nodeHashPassword('x');
    expect(script.split('$').slice(0, 2)).toEqual(app.split('$').slice(0, 2));
    expect(script.length).toBe(app.length);
  });

  it('does not consider a script-made hash in need of an upgrade', async () => {
    expect(needsRehash(await nodeHashPassword('x'))).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('a-perfectly-fine-password-1');
    expect((await verifyPassword('a-perfectly-fine-password-1', stored)).ok).toBe(true);
    expect((await verifyPassword('a-perfectly-fine-password-2', stored)).reason).toBe('mismatch');
  });

  it('is sensitive to surrounding whitespace, as a copy-paste would introduce', async () => {
    const stored = await hashPassword('spaced');
    expect((await verifyPassword('spaced ', stored)).reason).toBe('mismatch');
    expect((await verifyPassword(' spaced', stored)).reason).toBe('mismatch');
    expect((await verifyPassword('spaced\n', stored)).reason).toBe('mismatch');
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('calls a malformed hash unsupported rather than a mismatch', async () => {
    for (const bad of ['', 'nonsense', 'bcrypt$10$x$y', 'pbkdf2$$x$y', 'pbkdf2$6x100000$!!!$!!!']) {
      const result = await verifyPassword('x', bad);
      expect(result.ok, bad).toBe(false);
      expect(result.reason, bad).toBe('unsupported');
    }
  });
});

describe('needsRehash', () => {
  it('is false for a hash at the current work factor', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('is true for anything weaker or unparseable', () => {
    expect(needsRehash('pbkdf2$1x100000$AAAA$AAAA')).toBe(true);
    expect(needsRehash('pbkdf2$100000$AAAA$AAAA')).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });
});

describe('checkPasswordStrength', () => {
  it('accepts a reasonable password', () => {
    expect(checkPasswordStrength('Kowhai-Roasters-42').ok).toBe(true);
  });

  it('names each thing that is wrong', () => {
    expect(checkPasswordStrength('short').problems).toContain('Use at least 12 characters.');
    expect(checkPasswordStrength('alllowercase123').problems).toContain('Include an uppercase letter.');
    expect(checkPasswordStrength('NoDigitsInHere').problems).toContain('Include a digit.');
    expect(checkPasswordStrength('password123456A').problems.join(' ')).toMatch(/most guessed/);
  });
});
