#!/usr/bin/env node
/**
 * Create or reset a user. There is no sign-up in the app, so this is the
 * only way an account comes into existence.
 *
 *   npm run user:add -- --email you@example.com --name "Your Name" --local
 *   npm run user:add -- --email you@example.com --name "Your Name" --remote
 *
 * Omit --password and a strong one is generated and printed once.
 */

import { execFileSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { hashPassword, generatePassword } from './pbkdf2.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const email = flag('email')?.trim().toLowerCase();
const name = flag('name') ?? email;
const role = flag('role') ?? 'owner';
const remote = has('remote');

if (!email) {
  console.error('Usage: npm run user:add -- --email you@example.com --name "Your Name" [--local|--remote] [--password "..."] [--role owner|accountant|viewer]');
  process.exit(1);
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newId() {
  let now = Date.now();
  let time = '';
  for (let i = 9; i >= 0; i--) {
    time = ALPHABET[now % 32] + time;
    now = Math.floor(now / 32);
  }
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b % 32]).join('');
  return time + rand;
}

const password = flag('password') ?? generatePassword();
const generated = !flag('password');
const hash = await hashPassword(password);
const now = new Date().toISOString();
const userId = newId();
const settingsId = newId();

const escape = (v) => String(v).replace(/'/g, "''");

const sql = `
INSERT INTO users (id, email, name, password_hash, role, must_change_password, failed_attempts, created_at, updated_at)
VALUES ('${userId}', '${escape(email)}', '${escape(name)}', '${hash}', '${escape(role)}', ${generated ? 1 : 0}, 0, '${now}', '${now}')
ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  name = excluded.name,
  must_change_password = excluded.must_change_password,
  failed_attempts = 0,
  locked_until = NULL,
  disabled_at = NULL,
  updated_at = excluded.updated_at;

INSERT INTO settings (id, user_id, created_at, updated_at)
SELECT '${settingsId}', id, '${now}', '${now}' FROM users WHERE email = '${escape(email)}'
  AND NOT EXISTS (SELECT 1 FROM settings WHERE user_id = users.id);
`.trim();

const target = remote ? '--remote' : '--local';
execFileSync('npx', ['wrangler', 'd1', 'execute', 'jwbs-billing', target, '--command', sql], {
  stdio: 'inherit',
});

console.log('');
console.log(`  Account ready for ${email} (${target.replace('--', '')})`);
if (generated) {
  console.log(`  Password: ${password}`);
  console.log('  This is shown once. The user must change it at first sign-in.');
}
console.log('');
