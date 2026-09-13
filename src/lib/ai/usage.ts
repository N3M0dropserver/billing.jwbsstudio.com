/**
 * Instrumented model calls.
 *
 * The pipeline makes dozens of model calls per run, unattended, and before
 * this existed the only evidence any of them happened was the bill. Every
 * call now records what was asked, by which stage, how many tokens it moved,
 * how long it took, what it approximately cost and whether it was served from
 * cache.
 *
 * Two things are deliberately NOT recorded: the prompt and the response. They
 * contain crawled third-party content, and every question worth asking here —
 * which stage is expensive, which operation is slow, is the cache working —
 * is answered by shape and cost. A hash is kept so repeats can be counted.
 *
 * Nothing here may fail a run. A model call that succeeds and a logging
 * insert that fails is a successful call; the pipeline carries on and the
 * missing row is a gap in a chart, not a lost prospect.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import { aiCache, aiCalls } from '../db/schema';
import { newId } from '../id';
import { generate, generateJson, MODELS, type AiResult, type GenerateOptions } from './index';
import { costMicrocents, estimateTokens } from './pricing';

export interface AiUsageContext {
  db: Db;
  userId: string;
  /** What the call is for: qualify, shortlist, plan, proposal, brief. */
  operation: string;
  stage?: string;
  campaignId?: string | null;
  prospectId?: string | null;
  /** Hours an identical request may be reused. 0 disables the cache. */
  cacheTtlHours?: number;
}

/** SHA-256 of everything that changes the answer. */
export async function requestHash(options: GenerateOptions): Promise<string> {
  const canonical = JSON.stringify({
    model: options.model ?? MODELS.text,
    system: options.system,
    prompt: options.prompt,
    maxTokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.7,
  });

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function record(
  ctx: AiUsageContext,
  row: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    tokensMeasured: boolean;
    durationMs: number;
    cached: boolean;
    ok: boolean;
    error: string;
    hash: string;
  },
): Promise<void> {
  try {
    const cost = costMicrocents(row.model, row.promptTokens, row.completionTokens);

    await ctx.db.insert(aiCalls).values({
      id: newId(),
      userId: ctx.userId,
      campaignId: ctx.campaignId ?? null,
      prospectId: ctx.prospectId ?? null,
      stage: ctx.stage ?? '',
      operation: ctx.operation,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.promptTokens + row.completionTokens,
      tokensMeasured: row.tokensMeasured,
      // A cache hit costs nothing. Recording the price it would have been
      // would make the spend chart a chart of hypothetical spend.
      costMicrocents: row.cached ? 0 : cost.microcents,
      costConfident: cost.confident,
      durationMs: row.durationMs,
      cached: row.cached,
      ok: row.ok,
      error: row.error.slice(0, 500),
      requestHash: row.hash.slice(0, 16),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Observability must never be the thing that breaks the pipeline.
  }
}

interface CacheHit {
  response: string;
  promptTokens: number;
  completionTokens: number;
}

async function readCache(ctx: AiUsageContext, hash: string): Promise<CacheHit | null> {
  if (!ctx.cacheTtlHours || ctx.cacheTtlHours <= 0) return null;

  try {
    const rows = await ctx.db
      .select()
      .from(aiCache)
      .where(and(eq(aiCache.hash, hash), eq(aiCache.userId, ctx.userId)))
      .limit(1);

    const entry = rows[0];
    if (!entry) return null;
    if (entry.expiresAt <= new Date().toISOString()) return null;

    await ctx.db
      .update(aiCache)
      .set({ hits: sql`${aiCache.hits} + 1`, lastHitAt: new Date().toISOString() })
      .where(eq(aiCache.hash, hash));

    return {
      response: entry.response,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  ctx: AiUsageContext,
  hash: string,
  model: string,
  response: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  if (!ctx.cacheTtlHours || ctx.cacheTtlHours <= 0) return;

  try {
    const now = new Date();
    const expires = new Date(now.getTime() + ctx.cacheTtlHours * 3600_000);

    await ctx.db
      .insert(aiCache)
      .values({
        hash,
        userId: ctx.userId,
        model,
        operation: ctx.operation,
        response: response.slice(0, 100_000),
        promptTokens,
        completionTokens,
        hits: 0,
        expiresAt: expires.toISOString(),
        createdAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: aiCache.hash,
        set: { response: response.slice(0, 100_000), expiresAt: expires.toISOString() },
      });
  } catch {
    // A cache that cannot be written is a slow pipeline, not a broken one.
  }
}

/**
 * Pull usage out of a Workers AI response.
 *
 * Most models report it; the ones that do not get an estimate, flagged as
 * such so a chart can distinguish measured tokens from guessed ones.
 */
function readUsage(
  raw: unknown,
  systemAndPrompt: string,
  response: string,
): { promptTokens: number; completionTokens: number; measured: boolean } {
  const usage =
    raw && typeof raw === 'object' && 'usage' in raw
      ? (raw as { usage?: Record<string, unknown> }).usage
      : undefined;

  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);

  if (Number.isFinite(prompt) && Number.isFinite(completion)) {
    return { promptTokens: prompt, completionTokens: completion, measured: true };
  }

  return {
    promptTokens: estimateTokens(systemAndPrompt),
    completionTokens: estimateTokens(response),
    measured: false,
  };
}

/**
 * A tracked text call.
 *
 * The same contract as `generate`, plus a row in `ai_calls` and a shot at the
 * cache. Callers that do not care about either keep using `generate`.
 */
export async function trackedGenerate(
  ai: Ai,
  options: GenerateOptions,
  ctx: AiUsageContext,
): Promise<AiResult<string>> {
  const model = options.model ?? MODELS.text;
  const hash = await requestHash(options);
  const started = Date.now();

  const cached = await readCache(ctx, hash);
  if (cached) {
    await record(ctx, {
      model,
      promptTokens: cached.promptTokens,
      completionTokens: cached.completionTokens,
      tokensMeasured: false,
      durationMs: Date.now() - started,
      cached: true,
      ok: true,
      error: '',
      hash,
    });
    return { ok: true, data: cached.response };
  }

  const result = await generate(ai, options);
  const durationMs = Date.now() - started;

  if (!result.ok) {
    await record(ctx, {
      model,
      promptTokens: estimateTokens(options.system + options.prompt),
      completionTokens: 0,
      tokensMeasured: false,
      durationMs,
      cached: false,
      ok: false,
      error: result.error,
      hash,
    });
    return result;
  }

  const usage = readUsage(result.raw, options.system + options.prompt, result.data);

  await record(ctx, {
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    tokensMeasured: usage.measured,
    durationMs,
    cached: false,
    ok: true,
    error: '',
    hash,
  });

  await writeCache(ctx, hash, model, result.data, usage.promptTokens, usage.completionTokens);
  return result;
}

/** A tracked JSON call. Same contract as `generateJson`. */
export async function trackedGenerateJson<T>(
  ai: Ai,
  options: GenerateOptions,
  ctx: AiUsageContext,
): Promise<AiResult<T>> {
  // JSON calls want a low temperature; match `generateJson`'s default so the
  // cache key lines up with the request that is actually made.
  const withDefaults = { ...options, temperature: options.temperature ?? 0.2 };
  const text = await trackedGenerate(ai, withDefaults, ctx);
  if (!text.ok) return text;

  return generateJson<T>(ai, withDefaults, text.data);
}

/**
 * Drop expired cache rows.
 *
 * Called opportunistically rather than on a schedule: the table is small, and
 * a cron trigger is one more thing to deploy and remember.
 */
export async function pruneAiCache(db: Db, limit = 200): Promise<number> {
  try {
    const expired = await db
      .select({ hash: aiCache.hash })
      .from(aiCache)
      .where(lt(aiCache.expiresAt, new Date().toISOString()))
      .limit(limit);

    for (const row of expired) {
      await db.delete(aiCache).where(eq(aiCache.hash, row.hash));
    }
    return expired.length;
  } catch {
    return 0;
  }
}
