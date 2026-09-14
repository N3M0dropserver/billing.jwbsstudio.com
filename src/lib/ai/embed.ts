/**
 * Embeddings, for remembering things by meaning rather than by wording.
 *
 * The agent's memory has to answer "what do I know that bears on this?" — and
 * the useful memory is often the one that shares no words with the question.
 * A small embedding model handles that for a fraction of a cent per hundred
 * memories.
 *
 * Vectors live in D1 as JSON and similarity is computed in JavaScript. That
 * is the wrong answer at a hundred thousand memories and the right one here:
 * a working memory needs no new binding, no index to provision and no second
 * store to keep in step with the rows it describes. `memory.ts` caps how many
 * candidates are scored, so the cost stays bounded as the table grows.
 */

import { MODELS, type AiResult } from './index';

/** Vectors from this model. Recorded per row, so a model change is visible. */
export const EMBEDDING_MODEL = MODELS.embedding;

export async function embed(ai: Ai, texts: string[]): Promise<AiResult<number[][]>> {
  const input = texts.map((text) => text.slice(0, 2000)).filter((text) => text.trim().length > 0);
  if (input.length === 0) return { ok: false, error: 'Nothing to embed.' };

  try {
    const response = (await ai.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], {
      text: input,
    } as never)) as { data?: number[][] };

    const vectors = response?.data;
    if (!Array.isArray(vectors) || vectors.length !== input.length) {
      return { ok: false, error: 'The embedding model returned an unexpected shape.' };
    }
    return { ok: true, data: vectors, raw: response };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** One vector, or null. The shape most callers actually want. */
export async function embedOne(ai: Ai, text: string): Promise<number[] | null> {
  const result = await embed(ai, [text]);
  return result.ok ? (result.data[0] ?? null) : null;
}

/**
 * Cosine similarity, ranging -1..1.
 *
 * Vectors of different lengths mean the embedding model changed under us;
 * that scores zero rather than throwing, so an old memory simply stops
 * matching instead of breaking recall for every new one.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function parseVector(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? parsed : [];
  } catch {
    return [];
  }
}

/** Round before storing: four decimals costs nothing in recall and halves the row. */
export function serialiseVector(vector: number[]): string {
  return JSON.stringify(vector.map((n) => Math.round(n * 10_000) / 10_000));
}
