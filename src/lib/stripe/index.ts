/**
 * Stripe integration — payment links and webhook verification.
 *
 * Deliberately thin: no SDK. The Stripe Node SDK assumes Node crypto and
 * pulls in a lot for what is, here, two endpoints and a signature check.
 * Everything below is plain fetch and WebCrypto.
 *
 * Stripe is optional. With no key configured, invoices simply carry bank
 * details and nothing here is reached.
 */

import type { Cents, Currency } from '~/lib/tax/money';

const API = 'https://api.stripe.com/v1';

export function stripeEnabled(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

async function stripeRequest(
  env: Env,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe is not configured.' };

  try {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { message?: string } | undefined;
      return { ok: false, error: error?.message ?? `Stripe returned ${response.status}` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export interface PaymentLinkResult {
  ok: boolean;
  url?: string;
  sessionId?: string;
  error?: string;
}

/**
 * A Checkout Session rather than a reusable Payment Link, because a session
 * can carry the invoice id in metadata — which is what lets the webhook mark
 * the right invoice paid without guessing from the amount.
 */
export async function createCheckoutSession(
  env: Env,
  options: {
    invoiceId: string;
    invoiceNumber: string;
    amount: Cents;
    currency: Currency;
    clientEmail?: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<PaymentLinkResult> {
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][price_data][currency]': options.currency.toLowerCase(),
    'line_items[0][price_data][product_data][name]': `Invoice ${options.invoiceNumber}`,
    'line_items[0][price_data][unit_amount]': String(options.amount),
    'line_items[0][quantity]': '1',
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    'metadata[invoice_id]': options.invoiceId,
    'metadata[invoice_number]': options.invoiceNumber,
    // Surfaces on the Stripe dashboard and the customer's card statement.
    'payment_intent_data[metadata][invoice_id]': options.invoiceId,
  };
  if (options.clientEmail) params.customer_email = options.clientEmail;

  const result = await stripeRequest(env, '/checkout/sessions', params);
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    url: result.data.url as string,
    sessionId: result.data.id as string,
  };
}

/* ------------------------------------------------------------------ */
/* Webhook verification                                                */
/* ------------------------------------------------------------------ */

export interface VerifiedEvent {
  ok: boolean;
  event?: StripeEvent;
  error?: string;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Reject signatures older than this, so a captured payload cannot be replayed. */
const TOLERANCE_SECONDS = 300;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Stripe webhook signature.
 *
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256. The raw body text
 * must be used exactly as received — parsing and re-serialising the JSON
 * changes the bytes and the signature will never match.
 */
export async function verifyWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<VerifiedEvent> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return { ok: false, error: 'STRIPE_WEBHOOK_SECRET is not set.' };
  }
  if (!signatureHeader) {
    return { ok: false, error: 'Missing Stripe-Signature header.' };
  }

  const parts = new Map<string, string>();
  for (const segment of signatureHeader.split(',')) {
    const [key, value] = segment.split('=', 2);
    if (key && value) {
      // There can be several v1 signatures during a secret rotation.
      parts.set(key.trim() === 'v1' && parts.has('v1') ? 'v1_alt' : key.trim(), value.trim());
    }
  }

  const timestamp = parts.get('t');
  const signature = parts.get('v1');
  if (!timestamp || !signature) {
    return { ok: false, error: 'Malformed Stripe-Signature header.' };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number.parseInt(timestamp, 10));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return { ok: false, error: 'Webhook timestamp outside the tolerance window.' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const candidates = [signature, parts.get('v1_alt')].filter(Boolean) as string[];
  if (!candidates.some((candidate) => timingSafeEqual(candidate, expected))) {
    return { ok: false, error: 'Signature mismatch.' };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) as StripeEvent };
  } catch {
    return { ok: false, error: 'Webhook body was not valid JSON.' };
  }
}

/** Pull what we need out of a checkout.session.completed event. */
export function extractPayment(event: StripeEvent): {
  invoiceId?: string;
  amount?: Cents;
  currency?: string;
  chargeId?: string;
} | null {
  if (event.type !== 'checkout.session.completed' && event.type !== 'payment_intent.succeeded') {
    return null;
  }

  const object = event.data.object;
  const metadata = (object.metadata ?? {}) as Record<string, string>;

  return {
    invoiceId: metadata.invoice_id,
    amount:
      typeof object.amount_total === 'number'
        ? object.amount_total
        : typeof object.amount_received === 'number'
          ? object.amount_received
          : undefined,
    currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined,
    chargeId:
      typeof object.payment_intent === 'string'
        ? object.payment_intent
        : typeof object.id === 'string'
          ? object.id
          : undefined,
  };
}
