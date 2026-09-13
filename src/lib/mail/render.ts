/**
 * Variable substitution for user-authored email templates.
 *
 * Deliberately dumb. `{{path}}` and nothing else — no conditionals, no loops,
 * no expressions. A template language is a program, a program has bugs, and
 * these templates are edited in a browser by someone who wants to change a
 * greeting, not write software. Anything that needs a decision is decided in
 * TypeScript before the values map is built.
 *
 * The HTML pass escapes every substituted value. This is not optional: values
 * come from client records, and a client named `<script>` must not become one.
 */

export type TemplateValues = Record<string, string | number | null | undefined>;

/** `{{ invoice.number }}` — whitespace tolerated, dots and dashes allowed. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Substitute `{{token}}` occurrences.
 *
 * An unknown token renders as an empty string rather than being left visible.
 * A client should never receive an email containing the literal text
 * `{{invoice.number}}` — a missing value looks like an oversight, a leaked
 * token looks like a broken system.
 */
export function renderTemplate(
  source: string,
  values: TemplateValues,
  options: { escape?: boolean } = {},
): string {
  const escape = options.escape ?? true;

  return source.replace(TOKEN, (_match, key: string) => {
    const value = values[key];
    if (value === null || value === undefined) return '';
    const text = String(value);
    return escape ? escapeHtml(text) : text;
  });
}

/**
 * Tokens used by a template that have no corresponding value.
 *
 * Surfaced in the editor so a typo is caught while writing rather than
 * discovered as a blank space in a client's inbox.
 */
export function unknownTokens(source: string, values: TemplateValues): string[] {
  const missing = new Set<string>();
  for (const match of source.matchAll(TOKEN)) {
    const key = match[1];
    if (!(key in values)) missing.add(key);
  }
  return [...missing];
}
