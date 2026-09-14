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
  /** Reads images — receipts, at present. */
  vision: '@cf/meta/llama-3.2-11b-vision-instruct',
  /** Makes images — placeholder photography for demo sites. */
  image: '@cf/black-forest-labs/flux-1-schnell',
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
    const response = await ai.run(
      (options.model ?? MODELS.text) as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.prompt },
        ],
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.7,
      } as never,
    );

    const text = responseText(response);
    if (text === null) {
      return { ok: false, error: `The model returned ${describeShape(response)}.` };
    }
    if (!text.trim()) return { ok: false, error: 'The model returned nothing.' };
    return { ok: true, data: text.trim(), raw: response };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Get the text out of whatever Workers AI handed back.
 *
 * `{ response: string }` is the documented shape and the one we get most of
 * the time, but it is not the only one that arrives. A model serving an
 * OpenAI-compatible body returns `choices`; a newer instruct model can return
 * `response` as an array of content parts rather than a string; and a couple
 * return the string bare. Reading `.response` and calling `.trim()` on it
 * assumed the first shape and threw a TypeError on the rest — which the
 * caller recorded as a failed call, so an entire run scored fit 0 on every
 * prospect and fell back to ranking on need alone.
 *
 * Returns null when there is genuinely no text in there, so the caller can
 * say what shape it was rather than guessing.
 */
export function responseText(response: unknown): string | null {
  if (typeof response === 'string') return response;
  if (response === null || typeof response !== 'object') return null;

  // An array of content parts, at the top level or under a key below.
  if (Array.isArray(response)) return partsText(response);

  const body = response as Record<string, unknown>;

  for (const key of ['response', 'result', 'output_text', 'text', 'content']) {
    const value = body[key];
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const parts = partsText(value);
      if (parts) return parts;
    }
    // `{ result: { response: '...' } }` — the REST envelope, when a binding
    // hands one through rather than unwrapping it.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = responseText(value);
      if (nested) return nested;
    }
  }

  // OpenAI-compatible: choices[].message.content, or choices[].text.
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== 'object') continue;
      const nested = responseText(choice);
      if (nested) return nested;
      const message = (choice as Record<string, unknown>).message;
      if (message && typeof message === 'object') {
        const nestedMessage = responseText(message);
        if (nestedMessage) return nestedMessage;
      }
    }
  }

  return null;
}

/** Join an array of content parts — `[{ type: 'text', text: '...' }]`. */
function partsText(parts: unknown[]): string {
  const pieces: string[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      pieces.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    for (const key of ['text', 'content', 'response']) {
      if (typeof record[key] === 'string') {
        pieces.push(record[key] as string);
        break;
      }
    }
  }

  return pieces.join('');
}

/**
 * Name the shape of something we could not read, for the error line.
 *
 * Keys only — a response body can hold crawled third-party content, and this
 * string is written to the run log and the `ai_calls` table.
 */
export function describeShape(response: unknown): string {
  if (response === null) return 'null';
  if (Array.isArray(response)) return `an array of ${response.length}`;
  if (typeof response !== 'object') return `a ${typeof response}`;

  const keys = Object.keys(response as Record<string, unknown>).slice(0, 8);
  return keys.length
    ? `an object with no text in it (keys: ${keys.join(', ')})`
    : 'an empty object';
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

  const parsed = parseLooseJson<T>(result.data);
  if (parsed === null) {
    return { ok: false, error: 'The model did not return usable JSON.' };
  }

  return { ok: true, data: parsed };
}

/**
 * Parse the JSON a model meant to write.
 *
 * `JSON.parse` on the extracted value is tried first and is what usually
 * happens. What it cannot survive is the three ways a 70B instruct model
 * reliably breaks the format, none of which change what the model meant:
 *
 *   - A literal newline or tab inside a string. This one is not the model
 *     being sloppy — the plan prompt asks for paragraphs separated by a blank
 *     line, so it is being obedient, and `JSON.parse` rejects a raw control
 *     character in a string literal. It was the cause of nearly half the
 *     plans in a run coming back as "malformed JSON" and falling through to a
 *     scaffold, which is how a demo ends up as three headings with nothing
 *     under them.
 *   - A trailing comma before a closing brace or bracket.
 *   - Running out of tokens mid-value, so the JSON simply stops.
 *
 * Truncation is repaired by closing what is open, and — when that still does
 * not parse, because it stopped mid-key — by dropping back to the last
 * complete element. A plan missing its final section is worth having; a
 * scaffold is not.
 *
 * Returns null only when there is nothing recoverable in there.
 */
export function parseLooseJson<T>(text: string): T | null {
  const balanced = extractJson(text);

  for (const candidate of balanced === null ? [] : [balanced, repairJson(balanced)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next repair.
    }
  }

  // Nothing balanced in there: the response was cut off. Take everything from
  // the first bracket and let the repair close it.
  const source = unfence(text);
  const start = source.search(/[{[]/);
  if (start === -1) return null;

  for (const candidate of repairTruncated(source.slice(start))) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try a shorter one.
    }
  }

  return null;
}

/**
 * Fix the two things that break an otherwise complete JSON value: control
 * characters inside strings, and trailing commas.
 */
export function repairJson(source: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (inString) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        out += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        out += char;
        inString = false;
        continue;
      }
      out += escapeControl(char);
      continue;
    }

    if (char === '"') {
      out += char;
      inString = true;
      continue;
    }

    // A comma with nothing but whitespace between it and a closing bracket is
    // a trailing comma. Drop it rather than the value it follows.
    if (char === ',') {
      const rest = source.slice(i + 1);
      const next = rest.match(/^\s*([}\]])/);
      if (next) continue;
    }

    out += char;
  }

  return out;
}

/** A raw control character, as the escape JSON requires. */
function escapeControl(char: string): string {
  const code = char.charCodeAt(0);
  if (code > 0x1f) return char;

  if (char === '\n') return '\\n';
  if (char === '\r') return '\\r';
  if (char === '\t') return '\\t';
  if (char === '\b') return '\\b';
  if (char === '\f') return '\\f';
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * Candidate repairs for a value that stopped partway through, longest first.
 *
 * The first closes whatever is open where it stopped. If the response ran out
 * mid-key — `{"sections":[{"heading":"…","bo` — closing it produces an object
 * with a key and no value, which does not parse, so the ones after it drop
 * back to successively earlier element boundaries and close there instead.
 */
export function repairTruncated(source: string): string[] {
  const repaired = repairJson(source);

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  /** Output positions where a complete element ended, with the stack then. */
  const boundaries: Array<{ at: number; depth: number }> = [];

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') { stack.push(char === '{' ? '}' : ']'); continue; }
    if (char === '}' || char === ']') {
      stack.pop();
      boundaries.push({ at: i + 1, depth: stack.length });
      continue;
    }
    // A comma outside a string ends the element before it.
    if (char === ',') boundaries.push({ at: i, depth: stack.length });
  }

  const candidates: string[] = [];

  // Close it where it stopped, having tidied a dangling escape, an
  // unterminated string and a key left without a value.
  let head = escaped ? repaired.slice(0, -1) : repaired;
  if (inString) head += '"';
  candidates.push(close(head, stack));

  // Then fall back through the element boundaries, newest first. Each one is
  // a point where the value was, briefly, complete.
  for (let i = boundaries.length - 1; i >= 0 && candidates.length < 40; i--) {
    const boundary = boundaries[i]!;
    candidates.push(close(repaired.slice(0, boundary.at), stack.slice(0, boundary.depth)));
  }

  return candidates;
}

/** Close an open value: trim a dangling key or comma, then shut the brackets. */
function close(head: string, stack: string[]): string {
  let text = head.replace(/[\s,]+$/, '');
  // `{"a":` — a key with nowhere to put a value. `null` is closer to the
  // truth than dropping the key, and it parses.
  if (text.endsWith(':')) text += 'null';

  return text + [...stack].reverse().join('');
}

/** The inside of a code fence, where there is one. */
function unfence(text: string): string {
  return text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
}

/** Find the first balanced JSON object or array in a string. */
export function extractJson(text: string): string | null {
  const source = unfence(text);

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

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export interface GeneratedImage {
  body: ArrayBuffer;
  contentType: string;
}

export interface ImageOptions {
  prompt: string;
  model?: string;
  /**
   * Denoising steps. Schnell-class models are tuned for four and get no
   * better above eight, so this is capped rather than trusted.
   */
  steps?: number;
}

/** Decode standard base64 without Buffer, which Workers do not have. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Generate one image.
 *
 * Workers AI is inconsistent about how it hands an image back: the flux
 * models return JSON with a base64 string, the diffusion ones return a raw
 * PNG stream. Both shapes are handled here so callers get bytes either way.
 */
export async function generateImage(
  ai: Ai,
  options: ImageOptions,
): Promise<AiResult<GeneratedImage>> {
  const model = options.model ?? MODELS.image;

  try {
    const response = (await ai.run(model as Parameters<Ai['run']>[0], {
      prompt: options.prompt.slice(0, 2000),
      steps: Math.min(Math.max(options.steps ?? 4, 1), 8),
    } as never)) as { image?: string } | ReadableStream | ArrayBuffer | Uint8Array;

    if (response && typeof response === 'object' && 'image' in response && typeof response.image === 'string') {
      const body = base64ToArrayBuffer(response.image);
      if (body.byteLength === 0) return { ok: false, error: 'The model returned an empty image.' };
      return { ok: true, data: { body, contentType: 'image/jpeg' }, raw: { bytes: body.byteLength } };
    }

    if (response instanceof ReadableStream) {
      const body = await new Response(response).arrayBuffer();
      if (body.byteLength === 0) return { ok: false, error: 'The model returned an empty image.' };
      return { ok: true, data: { body, contentType: 'image/png' }, raw: { bytes: body.byteLength } };
    }

    if (response instanceof ArrayBuffer) {
      return { ok: true, data: { body: response, contentType: 'image/png' }, raw: { bytes: response.byteLength } };
    }

    if (response instanceof Uint8Array) {
      const body = response.buffer.slice(
        response.byteOffset,
        response.byteOffset + response.byteLength,
      ) as ArrayBuffer;
      return { ok: true, data: { body, contentType: 'image/png' }, raw: { bytes: body.byteLength } };
    }

    return { ok: false, error: 'The model returned an image in a shape we do not handle.' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
