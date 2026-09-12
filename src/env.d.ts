/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings.
 *
 * With @astrojs/cloudflare v14 the old `locals.runtime.env` accessor is
 * deprecated — bindings come from `import { env } from 'cloudflare:workers'`.
 * Use the helpers in `src/lib/env.ts` rather than importing that module
 * directly, so the one place that touches the runtime is easy to find.
 */
interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SESSION: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  /** Only present when MAIL_PROVIDER is "cloudflare". */
  EMAIL?: { send(message: unknown): Promise<void> };

  APP_NAME: string;
  APP_URL: string;
  MAIL_PROVIDER: 'cloudflare' | 'resend' | 'none';
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;

  SESSION_SECRET: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
}

declare namespace App {
  interface Locals {
    user: import('~/lib/db/schema').User | null;
    session: import('~/lib/db/schema').Session | null;
    cfContext: ExecutionContext;
  }
}
