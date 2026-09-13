import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// The generate-time script itself, so the rules are asserted where they live.
import { makeIdempotent, sweepMigrations } from '../scripts/idempotent-migrations.mjs';

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
