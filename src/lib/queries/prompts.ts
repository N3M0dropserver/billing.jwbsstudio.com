/**
 * Reading and writing the edited system prompts.
 *
 * A run reads these once per stage and passes them down, rather than each
 * call fetching its own — a campaign makes dozens of model calls and they all
 * want the same four rows.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { aiPrompts } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import {
  MAX_PROMPT_LENGTH,
  PROMPT_SPECS,
  promptSpec,
  stripContract,
  type PromptKey,
  type PromptOverrides,
} from '~/lib/growth/prompts';

/** Narrow an arbitrary form value to a prompt key. */
export function toPromptKey(value: unknown): PromptKey | null {
  return PROMPT_SPECS.some((spec) => spec.key === value) ? (value as PromptKey) : null;
}

/**
 * Every override this user has, keyed.
 *
 * An absent key means the default is in force. Nothing here throws: a prompt
 * that cannot be read is a run on the defaults, not a failed run.
 */
export async function loadPromptOverrides(db: Db, userId: string): Promise<PromptOverrides> {
  try {
    const rows = await db.select().from(aiPrompts).where(eq(aiPrompts.userId, userId));
    const overrides: PromptOverrides = {};

    for (const row of rows) {
      const key = toPromptKey(row.promptKey);
      if (key && row.instructions.trim()) overrides[key] = row.instructions;
    }

    return overrides;
  } catch {
    return {};
  }
}

/**
 * Save an edit, or clear it.
 *
 * Text identical to the default is stored as no override at all, so a prompt
 * someone reset by hand still picks up a later improvement to the default
 * rather than being frozen at today's wording.
 */
export async function savePromptOverride(
  db: Db,
  userId: string,
  key: PromptKey,
  instructions: string,
): Promise<void> {
  const spec = promptSpec(key);
  const cleaned = stripContract(instructions.slice(0, MAX_PROMPT_LENGTH), spec.contract).trim();
  const where = and(eq(aiPrompts.userId, userId), eq(aiPrompts.promptKey, key));

  if (!cleaned || cleaned === spec.instructions.trim()) {
    await db.delete(aiPrompts).where(where);
    return;
  }

  const now = new Date().toISOString();
  const existing = await db.select({ id: aiPrompts.id }).from(aiPrompts).where(where).limit(1);

  if (existing[0]) {
    await db
      .update(aiPrompts)
      .set({ instructions: cleaned, updatedAt: now })
      .where(eq(aiPrompts.id, existing[0].id));
    return;
  }

  await db.insert(aiPrompts).values({
    id: newId(),
    userId,
    promptKey: key,
    instructions: cleaned,
    createdAt: now,
    updatedAt: now,
  });
}
