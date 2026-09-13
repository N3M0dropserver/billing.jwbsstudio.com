import type { APIRoute } from 'astro';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '~/lib/env';
import { getSettings } from '~/lib/queries/settings';
import { bankTransactions } from '~/lib/db/schema';
import { newId } from '~/lib/id';
import { parseStatement } from '~/lib/bank/csv';

export const prerender = false;

/** A statement export, not a novel. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Enough for several years of a busy account; past this, split the file. */
const MAX_ROWS = 5_000;

/**
 * Import a bank CSV.
 *
 * Rows already held — recognised by fingerprint — are left exactly as they
 * are, including any match already confirmed against them. Re-importing an
 * overlapping period is therefore safe and, more to the point, expected: you
 * export the last 90 days each time rather than trying to remember where you
 * got to.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const file = form.get('statement');
  const source = String(form.get('source') ?? '').trim().slice(0, 100);

  if (!(file instanceof File) || file.size === 0) {
    return redirect('/bank?error=' + encodeURIComponent('Attach a CSV exported from your bank.'), 302);
  }
  if (file.size > MAX_BYTES) {
    return redirect(
      '/bank?error=' + encodeURIComponent('That file is over 4 MB. Export a shorter period.'),
      302,
    );
  }

  const parsed = parseStatement(await file.text());

  if (parsed.rows.length === 0) {
    const why = parsed.warnings[0] ?? 'No transactions could be read from that file.';
    return redirect(`/bank?error=${encodeURIComponent(why)}`, 302);
  }
  if (parsed.rows.length > MAX_ROWS) {
    return redirect(
      '/bank?error=' +
        encodeURIComponent(`That statement has ${parsed.rows.length} rows. Import at most ${MAX_ROWS} at a time.`),
      302,
    );
  }

  const database = db();
  const settings = await getSettings(database, user.id);

  // Which of these do we already hold? Chunked, because SQLite has a limit on
  // how many parameters one statement may carry.
  const fingerprints = parsed.rows.map((row) => row.fingerprint);
  const existing = new Set<string>();
  for (let i = 0; i < fingerprints.length; i += 200) {
    const slice = fingerprints.slice(i, i + 200);
    const found = await database
      .select({ fingerprint: bankTransactions.fingerprint })
      .from(bankTransactions)
      .where(
        and(eq(bankTransactions.userId, user.id), inArray(bankTransactions.fingerprint, slice)),
      );
    for (const row of found) existing.add(row.fingerprint);
  }

  const now = new Date().toISOString();
  const fresh = parsed.rows.filter((row) => !existing.has(row.fingerprint));

  for (let i = 0; i < fresh.length; i += 50) {
    const chunk = fresh.slice(i, i + 50);
    await database.insert(bankTransactions).values(
      chunk.map((row) => ({
        id: newId(),
        userId: user.id,
        source: source || file.name.slice(0, 100),
        occurredOn: row.date,
        amount: row.amount,
        currency: settings.defaultCurrency,
        description: row.description,
        reference: row.reference,
        fingerprint: row.fingerprint,
        status: 'unmatched' as const,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  const params = new URLSearchParams({
    imported: String(fresh.length),
    skipped: String(existing.size),
  });
  if (parsed.rejected.length > 0) params.set('rejected', String(parsed.rejected.length));
  if (parsed.warnings.length > 0) params.set('warning', parsed.warnings[0]!);

  return redirect(`/bank?${params.toString()}`, 302);
};
