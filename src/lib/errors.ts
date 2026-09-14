/**
 * Turning a thrown thing into a line a person can act on.
 *
 * `String(error)` keeps the outermost wrapper and silently discards
 * `error.cause`, which is where libraries put the sentence that says what
 * actually broke. Drizzle is the worst offender we have: a failed write
 * stringifies to the whole statement plus every bound parameter, and the D1
 * message — `no such column: scale_score` — is only on the cause. A run that
 * failed for a reason as plain as a missing column reports as a wall of SQL
 * with the reason nowhere in it.
 *
 * So: walk the chain, lead with the innermost message, and drop the bound
 * parameters. Those can be a prospect's contact details, and an error field
 * that is read in the UI and written to the log is not the place for them.
 */

/** Long enough for a real message, short enough to leave room for the cause. */
const MAX_PART = 400;

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value) {
    const { message } = value as { message: unknown };
    if (typeof message === 'string') return message;
  }
  return String(value);
}

/**
 * Drizzle writes `Failed query: <sql>\nparams: <every bound value>`. Cut at
 * the newline before `params:` — anchoring to the line start keeps this from
 * truncating a message that merely mentions the word.
 */
function withoutParams(message: string): string {
  return message.replace(/\n\s*params:[\s\S]*$/i, '');
}

function tidy(message: string): string {
  const collapsed = withoutParams(message).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PART ? `${collapsed.slice(0, MAX_PART - 1)}…` : collapsed;
}

/**
 * The message, innermost cause first.
 *
 * `D1_ERROR: no such column: scale_score — while: Failed query: insert into
 * "prospects" ...` rather than the other way round, because the first half of
 * the string is the half that survives truncation and gets read.
 */
export function describeError(error: unknown): string {
  const chain: string[] = [];

  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    const message = tidy(messageOf(current));
    if (message) chain.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }

  const parts: string[] = [];
  for (const message of chain.reverse()) {
    // A wrapper that merely restates its cause adds nothing.
    if (parts.some((part) => part.includes(message))) continue;
    parts.push(message);
  }

  return parts.join(' — while: ') || 'Failed without saying why.';
}
