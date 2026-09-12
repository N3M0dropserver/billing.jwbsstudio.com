/**
 * The single place that reaches into the Worker runtime.
 *
 * Everything else takes what it needs as an argument, which keeps the rest
 * of the codebase testable in plain Node.
 */

import { env } from 'cloudflare:workers';
import { getDb, type Db } from '~/lib/db';

export function bindings(): Env {
  return env as unknown as Env;
}

export function db(): Db {
  const e = bindings();
  if (!e.DB) {
    throw new Error(
      'D1 binding "DB" is missing. Check wrangler.jsonc and run through `wrangler dev` or a deployed Worker — `astro dev` alone has no bindings.',
    );
  }
  return getDb(e.DB);
}

export function files(): R2Bucket {
  const e = bindings();
  if (!e.FILES) throw new Error('R2 binding "FILES" is missing. Check wrangler.jsonc.');
  return e.FILES;
}

export function ai(): Ai {
  const e = bindings();
  if (!e.AI) throw new Error('Workers AI binding "AI" is missing. Check wrangler.jsonc.');
  return e.AI;
}

export function appUrl(): string {
  return bindings().APP_URL || 'http://localhost:8787';
}

export function sessionSecret(): string {
  const secret = bindings().SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Add it to .dev.vars locally, or `wrangler secret put SESSION_SECRET` for a deployment.',
    );
  }
  return secret;
}
