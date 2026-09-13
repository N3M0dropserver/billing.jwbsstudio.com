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
interface EmailAddress {
  email: string;
  name?: string;
}

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SESSION: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  /**
   * Cloudflare Email Service `send_email` binding. Only present when the
   * binding is declared in wrangler.jsonc.
   *
   * Typed against the structured send() API. `content` on an attachment also
   * accepts an ArrayBuffer, but we always send base64 — see src/lib/mail.
   */
  EMAIL?: {
    send(message: {
      from: string | EmailAddress;
      to: string | EmailAddress | (string | EmailAddress)[];
      subject: string;
      text?: string;
      html?: string;
      cc?: string | EmailAddress | (string | EmailAddress)[];
      bcc?: string | EmailAddress | (string | EmailAddress)[];
      replyTo?: string | EmailAddress;
      headers?: Record<string, string>;
      attachments?: Array<{
        content: string | ArrayBuffer | ArrayBufferView;
        filename: string;
        type: string;
        disposition: 'attachment' | 'inline';
        contentId?: string;
      }>;
    }): Promise<{ messageId: string }>;
  };

  /**
   * The campaign agent's Durable Object namespace, from the Worker in
   * `workers/agent`. Bound by `script_name`, so the class is not defined in
   * this Worker and only the stub type is available here.
   */
  CAMPAIGN_AGENT: DurableObjectNamespace;

  APP_NAME: string;
  APP_URL: string;
  /** Apex that generated demo sites are served under, e.g. demo.jwbsstudio.com. */
  DEMO_HOST?: string;
  MAIL_PROVIDER: 'cloudflare' | 'resend' | 'none';
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;

  SESSION_SECRET: string;
  /**
   * "1" prints magic-link URLs to the Worker log instead of relying on mail
   * getting through. A printed link is a working credential, so this belongs
   * in .dev.vars and nowhere near production.
   */
  AUTH_DEBUG?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;

  /** Enables the Google Places discovery provider. Optional — see the README. */
  GOOGLE_PLACES_API_KEY?: string;
  /**
   * Web search for checking how well known a business already is.
   *
   * Optional: the Wikidata lookup runs without it and catches the recognised
   * brands, which is most of the value. "brave" or "serper".
   */
  SEARCH_PROVIDER?: 'none' | 'brave' | 'serper';
  SEARCH_API_KEY?: string;
  /**
   * Only needed when demo subdomains get their own DNS records rather than
   * being covered by a wildcard. The token needs Zone:DNS:Edit on that zone
   * and nothing else.
   */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
}

declare namespace App {
  interface Locals {
    user: import('~/lib/db/schema').User | null;
    session: import('~/lib/db/schema').Session | null;
    cfContext: ExecutionContext;
  }
}
