import { eq } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { settings, type Settings } from '~/lib/db/schema';
import { newId } from '~/lib/id';

/**
 * Every user has exactly one settings row. It is created lazily so a user
 * provisioned by SQL never lands on a broken page.
 */
export async function getSettings(db: Db, userId: string): Promise<Settings> {
  const rows = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (rows[0]) return rows[0];

  const now = new Date().toISOString();
  const row = { id: newId(), userId, createdAt: now, updatedAt: now };
  await db.insert(settings).values(row);

  const created = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (!created[0]) throw new Error('Failed to create settings row.');
  return created[0];
}
