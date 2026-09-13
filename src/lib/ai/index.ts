/**
 * Workers AI helpers.
 *
 * Kept deliberately small and typed at the edges. The model name lives in
 * one place so it can be changed without touching callers, and every call
 * returns a discriminated result rather than throwing — an AI feature
 * failing must never take down a page that also shows your invoices.
 */

export const MODELS = {
  /** General reasoning and drafting. */
  text: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  /** Cheaper, for classification and scoring. */
  fast: '@cf/meta/llama-3.1-8b-instruct',
} as const;

export type AiResult<T> =
  /**
   * `raw` carries the provider's untouched response so callers that care —
   * the usage tracker — can read `usage` off it without this module having to
   * know what it will be asked for next.
   */
  | { ok: true; data: T; raw?: unknown }
  | { ok: false; error: string };

export interface GenerateOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function generate(ai: Ai, options: GenerateOptions): Promise<AiResult<string>> {
  try {
    const response = (await ai.run(
      (options.model ?? MODELS.text) as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.prompt },
        ],
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.7,
      } as never,
    )) as { response?: string } | string;

    const text = typeof response === 'string' ? response : (response.response ?? '');
    if (!text.trim()) return { ok: false, error: 'The model returned nothing.' };
    return { ok: true, data: text.trim(), raw: response };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Generate and parse JSON.
 *
 * Models wrap JSON in prose and code fences with enthusiasm, so the first
 * balanced JSON value in the response is extracted rather than trusting the
 * whole string to parse.
 */
export async function generateJson<T>(
  ai: Ai,
  options: GenerateOptions,
  /**
   * Text that has already been generated.
   *
   * Lets the tracked wrapper in `usage.ts` reuse one call for both the
   * request and the parse, rather than making the same request twice to get
   * a typed result.
   */
  existingText?: string,
): Promise<AiResult<T>> {
  const result =
    existingText !== undefined
      ? ({ ok: true, data: existingText } as AiResult<string>)
      : await generate(ai, { ...options, temperature: options.temperature ?? 0.2 });
  if (!result.ok) return result;

  const extracted = extractJson(result.data);
  if (extracted === null) {
    return { ok: false, error: 'The model did not return usable JSON.' };
  }

  try {
    return { ok: true, data: JSON.parse(extracted) as T };
  } catch {
    return { ok: false, error: 'The model returned malformed JSON.' };
  }
}

/** Find the first balanced JSON object or array in a string. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? text;

  const start = source.search(/[{[]/);
  if (start === -1) return null;

  const open = source[start] === '[' ? '[' : '{';
  const close = open === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i]!;

    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}
