import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// The generate-time script itself, so the rules are asserted where they live.
import { makeIdempotent, sweepMigrations } from '../scripts/idempotent-migrations.mjs';
// And the repair tool, for the same reason: one model of what a migration
// does to a database, used by the test and by `bun run db:drift` alike.
import { applyMigration, readSchema } from '../scripts/d1-drift.mjs';

const MIGRATIONS = join(process.cwd(), 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const sql = files.map((file) => [file, readFileSync(join(MIGRATIONS, file), 'utf8')] as const);

describe('every migration can meet a database that already has some of it', () => {
  it('has migrations to check at all', () => {
    // Guards against the glob silently matching nothing and the suite passing
    // on an empty set, which is the way a test like this usually rots.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(sql)('%s creates conditionally', (_file, text) => {
    // `CREATE TABLE x` without the guard aborts the whole migration when the
    // table is already there — see scripts/idempotent-migrations.mjs.
    expect(text).not.toMatch(/\bCREATE (TABLE|VIEW|TRIGGER) (?!IF NOT EXISTS)/i);
    expect(text).not.toMatch(/\bCREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
  });

  it.each(sql)('%s drops conditionally', (_file, text) => {
    expect(text).not.toMatch(/\bDROP (TABLE|INDEX|VIEW|TRIGGER) (?!IF EXISTS)/i);
  });

  it('leaves nothing for the sweep to fix', async () => {
    // The real assertion: run the same rules the generate step runs, and
    // require that they find no work. A migration added by hand, or one
    // freshly emitted by drizzle-kit without the sweep, fails here.
    const { changed } = await sweepMigrations({ check: true });
    expect(changed).toEqual([]);
  });
});

describe('the rewrite itself', () => {
  it('adds the guard to each bare form', () => {
    expect(makeIdempotent('CREATE TABLE `t` (id TEXT);')).toBe(
      'CREATE TABLE IF NOT EXISTS `t` (id TEXT);',
    );
    expect(makeIdempotent('CREATE UNIQUE INDEX `i` ON `t` (`id`);')).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS `i` ON `t` (`id`);',
    );
    expect(makeIdempotent('DROP TABLE `t`;')).toBe('DROP TABLE IF EXISTS `t`;');
  });

  it('is a no-op on a statement that already has it', () => {
    const already = 'CREATE TABLE IF NOT EXISTS `t` (id TEXT);';
    expect(makeIdempotent(already)).toBe(already);
    expect(makeIdempotent(makeIdempotent(already))).toBe(already);
  });

  it('leaves ALTER TABLE alone, because SQLite has no conditional form', () => {
    // Documented here so nobody "fixes" this by inventing syntax: SQLite
    // rejects `ADD COLUMN IF NOT EXISTS`. Re-running a migration that adds a
    // column fails, and the rule that prevents that is never renumbering an
    // applied migration.
    const alter = 'ALTER TABLE `t` ADD `c` text;';
    expect(makeIdempotent(alter)).toBe(alter);
  });

  it('does not touch a column or value that merely reads like a statement', () => {
    const insert = "INSERT INTO `t` (`note`) VALUES ('drop table later');";
    expect(makeIdempotent(insert)).toBe(insert);
  });
});

/**
 * The failure this suite was extended for.
 *
 * `0010_growth_engine.sql` was `0002_growth_engine.sql` until it was merged
 * and renumbered. Every database that had already applied it under the old
 * name ran it again under the new one — and because the guards let the
 * re-run get past the CREATEs, it reached the `prospects` rebuild and
 * replaced the table with its 2026-era shape, dropping the four columns
 * `0011` had added to it. `0011` re-ran too, and aborted on a column it had
 * already added long before it reached the ones it needed to put back.
 *
 * Guards alone cannot prevent that; only statement ORDER can. A migration
 * that both alters an existing table and rebuilds one must do the altering
 * first, so a re-run dies on `duplicate column name` while the rebuild is
 * still ahead of it.
 */
describe('re-applying a migration cannot narrow the schema', () => {
  const migrated = () => {
    const db = new DatabaseSync(':memory:');
    for (const [, text] of sql) applyMigration(db, text);
    return db;
  };

  it('models the state wrangler leaves behind', () => {
    // Guards against the rest of this block passing because the helper
    // silently applied nothing.
    const schema = readSchema(migrated());
    expect(schema.tables.get('prospects')?.has('scale_score')).toBe(true);
    expect(schema.tables.size).toBeGreaterThan(20);
  });

  it.each(sql)('%s leaves every column in place when run twice', (_file, text) => {
    const db = migrated();
    const before = readSchema(db);

    // An abort is fine — that is the migration refusing to run twice, which
    // is the desired outcome. Losing a column is not.
    applyMigration(db, text);
    const after = readSchema(db);

    for (const [table, columns] of before.tables) {
      expect(`${table}: ${[...after.tables.get(table)?.keys() ?? []].join(',')}`).toBe(
        `${table}: ${[...columns.keys()].join(',')}`,
      );
    }
  });
});
