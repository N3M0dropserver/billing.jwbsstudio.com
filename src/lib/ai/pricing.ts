/**
 * What a model call costs.
 *
 * Workers AI bills in *neurons* rather than tokens, and the neurons-per-token
 * ratio differs per model. That makes any token-based cost figure here an
 * estimate, and the honest thing is to say which numbers are confirmed and
 * which are not rather than presenting a single authoritative-looking dollar
 * amount.
 *
 * So every entry carries `confident`. Unconfirmed rates still produce a
 * figure — a rough number is far more useful than none when you are deciding
 * whether a stage is worth running unattended — but the UI marks any total
 * that includes one, and this file names where to check.
 *
 * Same convention as `src/lib/tax/rates.ts`: if it says verify, verify it.
 *
 * Check current pricing at:
 *   https://developers.cloudflare.com/workers-ai/platform/pricing/
 */

export interface ModelPrice {
  /** US cents per million input tokens. */
  inputCentsPerMillion: number;
  /** US cents per million output tokens. */
  outputCentsPerMillion: number;
  /** False means this is an estimate and should be shown as one. */
  confident: boolean;
  note: string;
}

/**
 * Cloudflare's published unit price for Workers AI.
 *
 * verify: $0.011 per 1,000 neurons at the time of writing. This is the one
 * number everything else is derived from, so it is worth checking first.
 */
export const CENTS_PER_1K_NEURONS = 1.1;

/**
 * Rates per model.
 *
 * verify: every entry below. They are order-of-magnitude right and good
 * enough to compare stages against each other, which is what the dashboard
 * is for. They are not good enough to reconcile against an invoice.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    inputCentsPerMillion: 2.9,
    outputCentsPerMillion: 22.5,
    confident: false,
    note: 'verify — derived from neuron pricing, not a published token rate',
  },
  '@cf/meta/llama-3.1-8b-instruct': {
    inputCentsPerMillion: 2.8,
    outputCentsPerMillion: 2.8,
    confident: false,
    note: 'verify — derived from neuron pricing, not a published token rate',
  },
  '@cf/baai/bge-base-en-v1.5': {
    inputCentsPerMillion: 1.2,
    // An embedding has no completion side, so this rate is never exercised —
    // it matches the input rate rather than sitting at zero so the table's
    // "output is never cheaper than input" invariant still holds.
    outputCentsPerMillion: 1.2,
    confident: false,
    note: 'verify — derived from neuron pricing, not a published token rate',
  },
};

/** A deliberately pessimistic stand-in for a model we have no rate for. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  inputCentsPerMillion: 5,
  outputCentsPerMillion: 25,
  confident: false,
  note: 'verify — no rate recorded for this model; a pessimistic placeholder',
};

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICING[model] ?? UNKNOWN_MODEL_PRICE;
}

/**
 * Cost in millionths of a cent.
 *
 * Integer microcents rather than floating-point dollars: these are summed
 * across thousands of rows, and a float that drifts in the third decimal
 * place makes a spend figure that never quite reconciles with itself.
 */
export function costMicrocents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): { microcents: number; confident: boolean } {
  const price = priceFor(model);
  const input = (promptTokens / 1_000_000) * price.inputCentsPerMillion;
  const output = (completionTokens / 1_000_000) * price.outputCentsPerMillion;
  return {
    microcents: Math.round((input + output) * 1_000_000),
    confident: price.confident,
  };
}

/**
 * Per-image rates for text-to-image models.
 *
 * Image models are billed per step per 512x512 tile rather than per token, so
 * they cannot go through `MODEL_PRICING` — a token-based estimate for one
 * would be wrong by orders of magnitude rather than by a rounding error.
 *
 * verify: every entry. These are derived from the neuron price above at the
 * default step count this app uses, which is what makes them estimates.
 */
export const IMAGE_PRICING: Record<string, { centsPerImage: number; confident: boolean; note: string }> = {
  '@cf/black-forest-labs/flux-1-schnell': {
    centsPerImage: 0.14,
    confident: false,
    note: 'verify — derived from neuron pricing at four steps, 1024x1024',
  },
};

export const UNKNOWN_IMAGE_PRICE = {
  centsPerImage: 0.5,
  confident: false,
  note: 'verify — no rate recorded for this image model; a pessimistic placeholder',
};

export function imagePriceFor(model: string): { centsPerImage: number; confident: boolean; note: string } {
  return IMAGE_PRICING[model] ?? UNKNOWN_IMAGE_PRICE;
}

/** Cost of generating `images` pictures, in microcents. */
export function imageCostMicrocents(
  model: string,
  images: number,
): { microcents: number; confident: boolean } {
  const price = imagePriceFor(model);
  return {
    microcents: Math.round(price.centsPerImage * Math.max(0, images) * 1_000_000),
    confident: price.confident,
  };
}

/** Microcents as something a person reads. */
export function formatCost(microcents: number): string {
  const cents = microcents / 1_000_000;
  if (cents === 0) return '$0.00';
  const dollars = cents / 100;
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  if (cents >= 0.01) return `${cents.toFixed(2)}c`;
  return '<0.01c';
}

/**
 * Estimate tokens from text when the provider did not report any.
 *
 * Roughly four characters per token for English prose. Wrong for code and for
 * languages that are not English, and flagged as an estimate everywhere it is
 * used, so nobody mistakes it for a measurement.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
