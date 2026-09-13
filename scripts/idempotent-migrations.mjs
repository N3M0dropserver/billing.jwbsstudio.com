#!/usr/bin/env node
/**
 * Make generated migrations safe to run against a database that already has
 * some of what they create.
 *
 * drizzle-kit emits bare `CREATE TABLE`, `CREATE INDEX` and `DROP TABLE`. Any
 * of those aborts the whole migration if the object is already there or is
 * already gone — and wrangler decides what to run by FILENAME, comparing
 * migrations/ against the names recorded in `d1_migrations`. So a renamed or
 * renumbered migration is re-run in full against a database that has already
 * had it, and the first CREATE kills the batch.
 *
 * This rewrites those statements to their conditional forms, in place, after
 * generation. It is wired into `bun run db:generate`; run it by hand after
 * editing a migration, or `--check` to assert the tree is clean (the
 * migrations test does exactly that).
 *
 * WHAT THIS CANNOT DO
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and no expression
 * form to fake one — re-adding a column is a hard "duplicate column name".
 * Since almost every drizzle migration past the first is ADD COLUMN, this
 * makes re-application *survivable further in*, not safe. The rule that keeps
 * a migration from being re-applied at all is the one in CLAUDE.md: never
 * renumber or rename a migration that has been applied anywhere.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Both rules are anchored to the start of a line, which is where drizzle puts
 * every statement it emits. That matters: an unanchored match would also
 * rewrite these words inside a string literal, quietly editing the DATA in a
 * seeding INSERT rather than the schema. The negative lookahead makes the
 * rewrite idempotent, so running it twice changes nothing.
 *
 * `CREATE TABLE __new_<x>` from drizzle's table-rebuild pattern is covered
 * deliberately. A rebuild that died midway leaves that scratch table behind,
 * and the retry should get past it rather than wedge on it; the rebuild
 * repopulates it from the original table in the very next statement.
 */
const CREATE = /^([ \t]*)(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER))\s+(?!IF\s+NOT\s+EXISTS\b)/gim;
const DROP = /^([ \t]*)(DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\s+(?!IF\s+EXISTS\b)/gim;

/** The rewrite, as a pure function, so the test can use it on a string. */
export function makeIdempotent(sql) {
  return sql
    .replace(CREATE, (_match, indent, keyword) => `${indent}${keyword} IF NOT EXISTS `)
    .replace(DROP, (_match, indent, keyword) => `${indent}${keyword} IF EXISTS `);
}

/**
 * The migrations that are not yet in conditional form, rewriting them unless
 * `check` is set. Exported so the test can ask the question without shelling
 * out, and so the rules live in exactly one place.
 */
export async function sweepMigrations({ check = false } = {}) {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const changed = [];

  for (const file of files) {
    const path = join(MIGRATIONS, file);
    const before = await readFile(path, 'utf8');
    const after = makeIdempotent(before);

    if (before === after) continue;

    changed.push(file);
    if (!check) await writeFile(path, after);
  }

  return { files, changed };
}

// Only when run as a command, so importing this for its rules costs nothing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  const { files, changed } = await sweepMigrations({ check });

  if (check && changed.length > 0) {
    console.error(
      `Migrations that would abort on a database that already has their objects:\n` +
        changed.map((f) => `  migrations/${f}`).join('\n') +
        `\n\nRun: bun run db:idempotent`,
    );
    process.exit(1);
  }

  if (check) console.log(`[migrations] ${files.length} files, all conditional.`);
  else if (changed.length > 0) console.log(`[migrations] made conditional: ${changed.join(', ')}`);
  else console.log(`[migrations] ${files.length} files, nothing to change.`);
}
