import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { emailTemplates, type EmailTemplate } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import type { TemplateKind } from '~/lib/mail/variables';

/**
 * Email template storage.
 *
 * Every read is scoped by userId. Templates are addressed by id in URLs, and
 * an id is guessable enough that "load by id" without an owner check would let
 * one account read another's drafts.
 */

export async function listTemplates(db: Db, userId: string): Promise<EmailTemplate[]> {
  return db
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.userId, userId), isNull(emailTemplates.archivedAt)))
    .orderBy(emailTemplates.kind, desc(emailTemplates.updatedAt));
}

export async function getTemplate(
  db: Db,
  userId: string,
  id: string,
): Promise<EmailTemplate | null> {
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.id, id), eq(emailTemplates.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The template pre-selected on the send form for a kind, if one is set. */
export async function defaultTemplate(
  db: Db,
  userId: string,
  kind: TemplateKind,
): Promise<EmailTemplate | null> {
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.userId, userId),
        eq(emailTemplates.kind, kind),
        eq(emailTemplates.isDefault, true),
        isNull(emailTemplates.archivedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createTemplate(
  db: Db,
  userId: string,
  input: { name: string; kind: TemplateKind; subject?: string },
): Promise<EmailTemplate> {
  const now = new Date().toISOString();
  const row = {
    id: newId(),
    userId,
    name: input.name,
    kind: input.kind,
    // Seeded from the chosen base template, if there was one. The body is not:
    // it is HTML, this column holds editor JSON, and the editor does that
    // conversion in the browser on first save.
    subject: input.subject ?? '',
    doc: '{}',
    html: '',
    text: '',
    isDefault: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(emailTemplates).values(row);
  return row as EmailTemplate;
}

export interface TemplateUpdate {
  name?: string;
  kind?: TemplateKind;
  subject?: string;
  doc?: string;
  html?: string;
  text?: string;
  isDefault?: boolean;
}

export async function updateTemplate(
  db: Db,
  userId: string,
  id: string,
  patch: TemplateUpdate,
): Promise<EmailTemplate | null> {
  const existing = await getTemplate(db, userId, id);
  if (!existing) return null;

  const kind = patch.kind ?? (existing.kind as TemplateKind);

  // At most one default per kind. Cleared before setting rather than after, so
  // a failure between the two leaves no default rather than two.
  if (patch.isDefault) {
    await db
      .update(emailTemplates)
      .set({ isDefault: false })
      .where(
        and(
          eq(emailTemplates.userId, userId),
          eq(emailTemplates.kind, kind),
          ne(emailTemplates.id, id),
        ),
      );
  }

  await db
    .update(emailTemplates)
    .set({ ...patch, kind, updatedAt: new Date().toISOString() })
    .where(and(eq(emailTemplates.id, id), eq(emailTemplates.userId, userId)));

  return getTemplate(db, userId, id);
}

/**
 * Soft delete.
 *
 * Past sends reference the template they were built from; hard-deleting would
 * either break that link or silently rewrite history.
 */
export async function archiveTemplate(db: Db, userId: string, id: string): Promise<boolean> {
  const existing = await getTemplate(db, userId, id);
  if (!existing) return false;

  await db
    .update(emailTemplates)
    .set({ archivedAt: new Date().toISOString(), isDefault: false })
    .where(and(eq(emailTemplates.id, id), eq(emailTemplates.userId, userId)));
  return true;
}

export async function duplicateTemplate(
  db: Db,
  userId: string,
  id: string,
): Promise<EmailTemplate | null> {
  const source = await getTemplate(db, userId, id);
  if (!source) return null;

  const now = new Date().toISOString();
  const row = {
    ...source,
    id: newId(),
    name: `${source.name} copy`,
    isDefault: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(emailTemplates).values(row);
  return row;
}
