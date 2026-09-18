import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '~/lib/db';
import { invoiceTemplates, type InvoiceTemplate } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import {
  DEFAULT_DESIGN,
  PRESETS,
  normalise,
  parseDesign,
  type InvoiceTemplateDesign,
} from '~/lib/pdf/template';

/**
 * Invoice template storage.
 *
 * Every read is scoped by userId. Templates are addressed by id in URLs, and
 * an id is guessable enough that "load by id" without an owner check would let
 * one account read — and render invoices with — another's designs.
 */

export interface TemplateWithDesign extends InvoiceTemplate {
  parsed: InvoiceTemplateDesign;
}

function withDesign(row: InvoiceTemplate): TemplateWithDesign {
  return { ...row, parsed: parseDesign(row.design) };
}

export async function listInvoiceTemplates(db: Db, userId: string): Promise<TemplateWithDesign[]> {
  const rows = await db
    .select()
    .from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.userId, userId), isNull(invoiceTemplates.archivedAt)))
    .orderBy(desc(invoiceTemplates.isDefault), desc(invoiceTemplates.updatedAt));
  return rows.map(withDesign);
}

/**
 * One template by id, archived or not.
 *
 * Archived ones still resolve on purpose: an invoice issued under a design
 * that has since been retired should keep rendering the way it was sent.
 */
export async function getInvoiceTemplate(
  db: Db,
  userId: string,
  id: string,
): Promise<TemplateWithDesign | null> {
  const rows = await db
    .select()
    .from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.id, id), eq(invoiceTemplates.userId, userId)))
    .limit(1);
  return rows[0] ? withDesign(rows[0]) : null;
}

export async function defaultInvoiceTemplate(
  db: Db,
  userId: string,
): Promise<TemplateWithDesign | null> {
  const rows = await db
    .select()
    .from(invoiceTemplates)
    .where(
      and(
        eq(invoiceTemplates.userId, userId),
        eq(invoiceTemplates.isDefault, true),
        isNull(invoiceTemplates.archivedAt),
      ),
    )
    .limit(1);
  return rows[0] ? withDesign(rows[0]) : null;
}

/**
 * The design an invoice should actually be drawn with.
 *
 * In order: the template the invoice names, the account default, then the
 * built-in. The last branch is what runs for an account that has never opened
 * the designer, and it is why adding this feature changed nobody's invoices.
 */
export async function designFor(
  db: Db,
  userId: string,
  templateId: string | null,
): Promise<InvoiceTemplateDesign> {
  if (templateId) {
    const named = await getInvoiceTemplate(db, userId, templateId);
    if (named) return named.parsed;
  }
  const fallback = await defaultInvoiceTemplate(db, userId);
  return fallback?.parsed ?? DEFAULT_DESIGN;
}

export async function createInvoiceTemplate(
  db: Db,
  userId: string,
  input: { name: string; description?: string; design?: unknown; isDefault?: boolean },
): Promise<TemplateWithDesign> {
  const now = new Date().toISOString();
  const row = {
    id: newId(),
    userId,
    name: input.name.trim() || 'Untitled template',
    description: input.description?.trim() ?? '',
    design: JSON.stringify(normalise(input.design ?? DEFAULT_DESIGN)),
    // The first template an account creates becomes its default, so saving one
    // has the effect people expect without a second step.
    isDefault: input.isDefault ?? (await listInvoiceTemplates(db, userId)).length === 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(invoiceTemplates).values(row);
  if (row.isDefault) await clearOtherDefaults(db, userId, row.id);
  return withDesign(row as InvoiceTemplate);
}

export async function updateInvoiceTemplate(
  db: Db,
  userId: string,
  id: string,
  changes: { name?: string; description?: string; design?: unknown; isDefault?: boolean },
): Promise<TemplateWithDesign | null> {
  const existing = await getInvoiceTemplate(db, userId, id);
  if (!existing) return null;

  const patch: Partial<InvoiceTemplate> = { updatedAt: new Date().toISOString() };
  if (changes.name !== undefined) patch.name = changes.name.trim() || existing.name;
  if (changes.description !== undefined) patch.description = changes.description.trim();
  if (changes.design !== undefined) patch.design = JSON.stringify(normalise(changes.design));
  if (changes.isDefault !== undefined) patch.isDefault = changes.isDefault;

  await db
    .update(invoiceTemplates)
    .set(patch)
    .where(and(eq(invoiceTemplates.id, id), eq(invoiceTemplates.userId, userId)));

  if (patch.isDefault) await clearOtherDefaults(db, userId, id);

  return getInvoiceTemplate(db, userId, id);
}

/**
 * Retire a template.
 *
 * Soft, and it never touches the invoices that name it — see the comment on
 * `getInvoiceTemplate`. If the default is retired, the account falls back to
 * the built-in design rather than silently adopting another template.
 */
export async function archiveInvoiceTemplate(db: Db, userId: string, id: string): Promise<boolean> {
  const existing = await getInvoiceTemplate(db, userId, id);
  if (!existing) return false;

  await db
    .update(invoiceTemplates)
    .set({ archivedAt: new Date().toISOString(), isDefault: false, updatedAt: new Date().toISOString() })
    .where(and(eq(invoiceTemplates.id, id), eq(invoiceTemplates.userId, userId)));

  return true;
}

/** At most one default per account. */
async function clearOtherDefaults(db: Db, userId: string, keep: string): Promise<void> {
  await db
    .update(invoiceTemplates)
    .set({ isDefault: false })
    .where(and(eq(invoiceTemplates.userId, userId), ne(invoiceTemplates.id, keep)));
}

/**
 * Give an account the starter set, once.
 *
 * Called the first time someone opens the designer rather than at signup: an
 * account that never wants templates never gets rows, and the built-in
 * default keeps producing the invoices it always did.
 */
export async function seedInvoiceTemplates(db: Db, userId: string): Promise<TemplateWithDesign[]> {
  const existing = await listInvoiceTemplates(db, userId);
  if (existing.length) return existing;

  const now = new Date().toISOString();
  const rows = PRESETS.map((preset, i) => ({
    id: newId(),
    userId,
    name: preset.name,
    description: preset.description,
    design: JSON.stringify(normalise(preset.design)),
    isDefault: i === 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  await db.insert(invoiceTemplates).values(rows);
  return rows.map((row) => withDesign(row as InvoiceTemplate));
}
