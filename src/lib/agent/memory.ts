/**
 * What the agent knows, between runs.
 *
 * The pipeline used to start every campaign from nothing. It would work out —
 * again — that physiotherapists in this country almost never publish prices,
 * that a particular directory's phone numbers are usually stale, that you
 * hate the word "bespoke". None of that survived the run that learned it.
 *
 * A memory is one sentence, scoped to where it applies, with a note of where
 * it came from. Recall is by meaning when an embedding model is available and
 * by words when it is not, and either way the selected memories are shown to
 * the model as *notes from previous runs*, not as instructions — a memory
 * that turns out to be wrong should be contradicted by what is in front of
 * it, not defended.
 *
 * Three rules keep this from becoming a junk drawer:
 *
 *   - Writing is deduplicated. The same lesson learned twice raises the
 *     confidence of one row rather than adding a second.
 *   - Recall is capped and scored, so a thousand memories cost the same
 *     prompt space as ten.
 *   - Every memory is visible and deletable on the growth pages. Anything the
 *     agent remembers, you can read and remove.
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import {
  agentMemories,
  type AgentMemory,
  type MemoryKind,
  type MemoryScope,
} from '../db/schema';
import { newId } from '../id';
import { cosine, parseVector, serialiseVector, EMBEDDING_MODEL } from '../ai/embed';
import { trackedEmbed, type AiUsageContext } from '../ai/usage';

export interface MemoryContext {
  db: Db;
  userId: string;
  /** Omitted when embeddings are off or unavailable; recall still works. */
  ai?: Ai;
  /** Where the embedding call is booked. */
  usage?: AiUsageContext;
  enabled?: boolean;
}

export interface RememberInput {
  content: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  scopeKey?: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  campaignId?: string | null;
  prospectId?: string | null;
  pinned?: boolean;
}

/** Two memories this close in meaning are the same memory. */
export const DUPLICATE_SIMILARITY = 0.93;

/** How many rows recall will score. Beyond this, the oldest are not considered. */
export const RECALL_CANDIDATES = 400;

/**
 * Write something down.
 *
 * Returns the row, or null when there was nothing worth keeping — a memory
 * shorter than a clause is noise, and one that duplicates an existing memory
 * reinforces it instead.
 */
export async function remember(
  ctx: MemoryContext,
  input: RememberInput,
): Promise<AgentMemory | null> {
  if (ctx.enabled === false) return null;

  const content = input.content.trim().replace(/\s+/g, ' ').slice(0, 600);
  if (content.length < 12) return null;

  const scope = input.scope ?? 'global';
  const scopeKey = normaliseKey(input.scopeKey ?? '');
  const vector = await embedFor(ctx, content);

  const existing = await findDuplicate(ctx, content, scope, scopeKey, vector);
  if (existing) {
    // Learned again is learned better — but cap it, so a lesson repeated by
    // a loop cannot become unassailable.
    const confidence = Math.min(95, existing.confidence + 8);
    await ctx.db
      .update(agentMemories)
      .set({ confidence, useCount: existing.useCount + 1, updatedAt: new Date().toISOString() })
      .where(eq(agentMemories.id, existing.id));
    return { ...existing, confidence };
  }

  const now = new Date().toISOString();
  const row = {
    id: newId(),
    userId: ctx.userId,
    scope,
    scopeKey,
    kind: input.kind ?? 'fact',
    content,
    tags: JSON.stringify((input.tags ?? []).map((tag) => tag.toLowerCase().slice(0, 40)).slice(0, 12)),
    source: (input.source ?? '').slice(0, 80),
    campaignId: input.campaignId ?? null,
    prospectId: input.prospectId ?? null,
    confidence: clamp(input.confidence ?? 60, 1, 100),
    pinned: input.pinned ?? false,
    useCount: 0,
    lastUsedAt: null,
    embedding: vector ? serialiseVector(vector) : '',
    embeddingModel: vector ? EMBEDDING_MODEL : '',
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof agentMemories.$inferInsert;

  await ctx.db.insert(agentMemories).values(row);
  return row as AgentMemory;
}

export interface RecallOptions {
  /** What is being worked on, in words. Matched against every memory. */
  query: string;
  /** Scopes to consider, most specific first. Global is always included. */
  scopes?: Array<{ scope: MemoryScope; key: string }>;
  limit?: number;
  minConfidence?: number;
}

export interface ScoredMemory {
  memory: AgentMemory;
  score: number;
  /** How the match was made, so the UI can say so honestly. */
  matchedBy: 'embedding' | 'keyword' | 'scope';
}

/**
 * What do I know that bears on this?
 *
 * Scoring is deliberately not pure similarity. A memory about this exact
 * prospect beats a cleverer semantic match about the trade in general, a
 * pinned memory is always in the running, and a memory that has been useful
 * before is worth slightly more than one that never has.
 */
export async function recall(ctx: MemoryContext, options: RecallOptions): Promise<ScoredMemory[]> {
  if (ctx.enabled === false) return [];

  const limit = Math.min(Math.max(options.limit ?? 6, 1), 20);
  const scopes = options.scopes ?? [];
  const minConfidence = options.minConfidence ?? 20;

  const scopeFilters = scopes
    .filter((entry) => entry.key)
    .map((entry) =>
      and(eq(agentMemories.scope, entry.scope), eq(agentMemories.scopeKey, normaliseKey(entry.key))),
    );

  const candidates = await ctx.db
    .select()
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.userId, ctx.userId),
        isNull(agentMemories.retiredAt),
        sql`${agentMemories.confidence} >= ${minConfidence}`,
        scopeFilters.length
          ? or(eq(agentMemories.scope, 'global'), ...scopeFilters)
          : eq(agentMemories.scope, 'global'),
      ),
    )
    .orderBy(desc(agentMemories.pinned), desc(agentMemories.createdAt))
    .limit(RECALL_CANDIDATES);

  if (candidates.length === 0) return [];

  const vector = await embedFor(ctx, options.query);
  const queryTokens = tokenise(options.query);

  const scored = candidates.map((memory) => scoreMemory(memory, { vector, queryTokens, scopes }));

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Score one memory against one task. Pure, so it can be reasoned about and
 * tested without a database or a model.
 */
export function scoreMemory(
  memory: AgentMemory,
  against: {
    vector: number[] | null;
    queryTokens: string[];
    scopes: Array<{ scope: MemoryScope; key: string }>;
  },
): ScoredMemory {
  const stored = parseVector(memory.embedding);
  let matchedBy: ScoredMemory['matchedBy'] = 'scope';
  let relevance = 0;

  if (against.vector && stored.length) {
    // Cosine runs -1..1; only positive similarity is evidence of anything.
    relevance = Math.max(0, cosine(against.vector, stored));
    matchedBy = 'embedding';
  } else {
    relevance = keywordOverlap(against.queryTokens, tokenise(`${memory.content} ${memory.tags}`));
    if (relevance > 0) matchedBy = 'keyword';
  }

  // A memory scoped to exactly what is being worked on is relevant by
  // construction, whatever the words say.
  const scopeHit = against.scopes.some(
    (entry) => entry.key && memory.scope === entry.scope && memory.scopeKey === normaliseKey(entry.key),
  );

  if (scopeHit && relevance < 0.35) {
    relevance = 0.35;
    if (matchedBy === 'scope') matchedBy = 'scope';
  }

  if (relevance === 0 && !memory.pinned) return { memory, score: 0, matchedBy };

  const score =
    relevance * 60 +
    (memory.confidence / 100) * 15 +
    (scopeHit ? 12 : 0) +
    (memory.pinned ? 20 : 0) +
    Math.min(memory.useCount, 5) * 1.5;

  return { memory, score, matchedBy };
}

/**
 * Note that these memories were used.
 *
 * Not for its own sake: a memory that is recalled constantly is one worth
 * keeping when the table is pruned, and one that never surfaces in six months
 * is one worth showing you so you can delete it.
 */
export async function reinforce(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(agentMemories)
      .set({ useCount: sql`${agentMemories.useCount} + 1`, lastUsedAt: new Date().toISOString() })
      .where(inArray(agentMemories.id, ids));
  } catch {
    // Bookkeeping. Never worth failing a run over.
  }
}

/** Mark a memory wrong. Kept, so the mistake stays reviewable. */
export async function retire(db: Db, userId: string, id: string, reason = ''): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(agentMemories)
    .set({
      retiredAt: now,
      updatedAt: now,
      source: reason ? `retired: ${reason}`.slice(0, 80) : undefined,
      confidence: 10,
    })
    .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, userId)));
}

/** Memories as a prompt block: plain lines, clearly labelled as recall. */
export function renderMemories(entries: ScoredMemory[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const where =
      entry.memory.scope === 'global' ? '' : ` (${entry.memory.scope}: ${entry.memory.scopeKey})`;
    return `- ${entry.memory.content}${where} [${entry.memory.kind}, confidence ${entry.memory.confidence}]`;
  });

  return `Notes from previous runs. Treat them as recollections, not rules — if what is in front of you contradicts one, believe what is in front of you and say so.\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

async function embedFor(ctx: MemoryContext, text: string): Promise<number[] | null> {
  if (!ctx.ai) return null;
  try {
    const result = ctx.usage
      ? await trackedEmbed(ctx.ai, [text], ctx.usage)
      : await trackedEmbed(ctx.ai, [text], {
          db: ctx.db,
          userId: ctx.userId,
          operation: 'memory',
        });
    return result.ok ? (result.data[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Is this already known?
 *
 * Exact text first — cheap, and catches the common case of the same
 * reflection running twice. Then similarity, within the same scope only: the
 * same sentence about two different prospects is two memories, not one.
 */
async function findDuplicate(
  ctx: MemoryContext,
  content: string,
  scope: MemoryScope,
  scopeKey: string,
  vector: number[] | null,
): Promise<AgentMemory | null> {
  const sameScope = await ctx.db
    .select()
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.userId, ctx.userId),
        eq(agentMemories.scope, scope),
        eq(agentMemories.scopeKey, scopeKey),
        isNull(agentMemories.retiredAt),
      ),
    )
    .orderBy(desc(agentMemories.createdAt))
    .limit(200);

  const normalised = content.toLowerCase();
  const exact = sameScope.find((row) => row.content.toLowerCase() === normalised);
  if (exact) return exact;

  if (!vector) return null;

  for (const row of sameScope) {
    const stored = parseVector(row.embedding);
    if (stored.length && cosine(vector, stored) >= DUPLICATE_SIMILARITY) return row;
  }

  return null;
}

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map(stem);
}

/**
 * A crude stem, and worth the crudeness.
 *
 * Without it "physiotherapist" and "physiotherapy" are unrelated words, and
 * the keyword fallback — the path taken whenever the embedding model is
 * unavailable — misses the memory that was written about exactly this trade.
 * Nothing here tries to be a real stemmer: it strips the handful of endings
 * that separate a trade from its practitioner and a plural from its singular,
 * and leaves anything that would shrink a word below four letters alone.
 */
export function stem(token: string): string {
  const endings = ['ists', 'ist', 'ies', 'ers', 'ing', 'ed', 'es', 'er', 'ly', 's', 'y'];

  for (const ending of endings) {
    if (token.length - ending.length >= 4 && token.endsWith(ending)) {
      const stemmed = token.slice(0, -ending.length);
      // "ies" is a plural of a "y" word; both land on the same stem because
      // the "y" rule below would have taken it there anyway.
      return stemmed;
    }
  }

  return token;
}

/**
 * Overlap as a fraction of the query, not of the union.
 *
 * A long memory that happens to contain every word of a short question is a
 * good match; scoring it against its own length would bury it.
 */
export function keywordOverlap(query: string[], target: string[]): number {
  if (query.length === 0 || target.length === 0) return 0;
  const haystack = new Set(target);
  const hits = query.filter((token) => haystack.has(token)).length;
  return hits / query.length;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one',
  'our', 'out', 'has', 'had', 'his', 'how', 'its', 'who', 'did', 'yes', 'this', 'that', 'with',
  'from', 'they', 'have', 'been', 'were', 'what', 'when', 'your', 'will', 'about', 'would',
  'there', 'their', 'which', 'them', 'then', 'than', 'into', 'more', 'some', 'like',
]);

function normaliseKey(value: string): string {
  return value.trim().toLowerCase().slice(0, 120);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.round(value), low), high);
}
