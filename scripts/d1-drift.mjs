#!/usr/bin/env node
/**
 * Compare a live D1 database with the schema `migrations/` actually produces,
 * and print the SQL that would put it back in step.
 *
 * WHY THIS EXISTS
 *
 * wrangler decides what to apply by FILENAME. A migration that was renumbered
 * after it had been applied somewhere is therefore run again, from the top,
 * against a database that already has it — and a migration that rebuilds a
 * table (`CREATE __new_x` / copy / `DROP x` / `RENAME`) will happily rebuild
 * it back to the shape it had at the time that migration was written, losing
 * every column a later migration added. The guards from
 * `scripts/idempotent-migrations.mjs` do not stop that; they are what lets the
 * re-run get far enough to do it.
 *
 * The result is a database that is neither the old schema nor the new one,
 * and an application that fails with `no such column` on a write that has
 * worked for weeks. That is silent until something writes, which is why this
 * exists: run it and the answer is a list of columns, not an error message.
 *
 * USAGE
 *
 *   bun run db:drift            # local D1 (--local)
 *   bun run db:drift --remote   # production
 *   bun run db:drift --remote --apply
 *
 * Without `--apply` it only reports. With it, the ADD COLUMN and the
 * `d1_migrations` bookkeeping rows below are executed — both are additive.
 */

import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

// `node:sqlite` prints an experimental notice on import. This uses only
// `exec`/`prepare`, which are not the parts in flux, and the notice sits in
// the middle of the report where it reads like part of the diagnosis.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (!/SQLite is an experimental feature/.test(warning.message)) console.warn(warning);
});

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'migrations');
const DATABASE = 'jwbs-billing';

/* ------------------------------------------------------------------ */
/* The schema the migrations describe                                  */
/* ------------------------------------------------------------------ */

/** Statements, in order, as wrangler would run them. */
export function statementsOf(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement && !statement.split('\n').every((l) => l.startsWith('--')));
}

export async function migrationFiles(dir = MIGRATIONS) {
  return (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
}

/**
 * Apply one migration, stopping where wrangler would stop.
 *
 * A migration that throws leaves everything before the throw in place — that
 * is exactly what a half-applied migration looks like in production, and the
 * point of modelling it rather than wrapping the file in a transaction.
 */
export function applyMigration(db, sql) {
  for (const statement of statementsOf(sql)) {
    try {
      db.exec(statement);
    } catch (error) {
      return { ok: false, statement, error: error.message };
    }
  }
  return { ok: true };
}

/** Read a database into `{ tables: Map<name, Map<column, info>>, indexes: Map }`. */
export function readSchema(db) {
  const tables = new Map();
  const indexes = new Map();

  const objects = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all();

  for (const object of objects) {
    if (object.type === 'table') {
      const columns = new Map();
      for (const column of db.prepare(`SELECT * FROM pragma_table_info(?)`).all(object.name)) {
        columns.set(column.name, {
          name: column.name,
          type: column.type,
          notNull: Boolean(column.notnull),
          default: column.dflt_value,
          pk: Boolean(column.pk),
        });
      }
      tables.set(object.name, columns);
    } else if (object.type === 'index' && object.sql) {
      indexes.set(object.name, object.sql);
    }
  }

  return { tables, indexes };
}

/** The schema a database gets from a clean run of every migration. */
export async function schemaFromMigrations(dir = MIGRATIONS) {
  const db = new DatabaseSync(':memory:');
  const failures = [];
  for (const file of await migrationFiles(dir)) {
    const result = applyMigration(db, await readFile(join(dir, file), 'utf8'));
    if (!result.ok) failures.push({ file, ...result });
  }
  if (failures.length) {
    const [first] = failures;
    throw new Error(`${first.file} does not apply to an empty database: ${first.error}`);
  }
  return readSchema(db);
}

/* ------------------------------------------------------------------ */
/* The difference                                                      */
/* ------------------------------------------------------------------ */

/**
 * What `live` is missing compared with `expected`.
 *
 * Deliberately one-directional about tables and columns: a column the live
 * database has and the migrations do not is left alone and only mentioned.
 * Dropping it would be the same class of mistake this script exists to find.
 */
export function diffSchemas(expected, live) {
  const missingTables = [];
  const missingColumns = [];
  const extraColumns = [];

  for (const [table, columns] of expected.tables) {
    const liveColumns = live.tables.get(table);
    if (!liveColumns) {
      missingTables.push(table);
      continue;
    }
    for (const [name, column] of columns) {
      if (!liveColumns.has(name)) missingColumns.push({ table, column });
    }
    for (const name of liveColumns.keys()) {
      if (!columns.has(name)) extraColumns.push({ table, column: name });
    }
  }

  const missingIndexes = [...expected.indexes.entries()]
    .filter(([name]) => !live.indexes.has(name))
    .map(([name, sql]) => ({ name, sql }));

  return { missingTables, missingColumns, missingIndexes, extraColumns };
}

/**
 * `ALTER TABLE ... ADD COLUMN` for a column the live database lacks.
 *
 * Returns null when SQLite cannot add the column at all: NOT NULL without a
 * default, or a primary key. Those need the table rebuilt, which is a
 * migration rather than a repair, so say so instead of emitting SQL that
 * fails.
 */
export function addColumnSql({ table, column }) {
  if (column.pk) return null;
  if (column.notNull && column.default == null) return null;

  const parts = [`ALTER TABLE \`${table}\` ADD \`${column.name}\``];
  if (column.type) parts.push(column.type);
  if (column.default != null) parts.push(`DEFAULT ${column.default}`);
  if (column.notNull) parts.push('NOT NULL');
  return `${parts.join(' ')};`;
}

/**
 * Rows to add to `d1_migrations` for files wrangler would otherwise re-run.
 *
 * A file that is on disk but not recorded gets run in full on the next
 * `migrations apply`. When the database plainly already has that migration —
 * which a renumbering is — recording the new name is the fix, and the
 * `WHERE NOT EXISTS` makes it safe to run twice.
 */
export function recordMigrationSql(name) {
  return (
    `INSERT INTO d1_migrations (name, applied_at)\n` +
    `SELECT '${name}', CURRENT_TIMESTAMP\n` +
    `WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${name}');`
  );
}

/* ------------------------------------------------------------------ */
/* Talking to D1                                                       */
/* ------------------------------------------------------------------ */

/**
 * What wrangler was actually complaining about.
 *
 * With `--json` it reports failures as `{"error":{"text":…}}` on STDOUT and
 * exits non-zero; stderr carries only the banner. Reading stderr first — the
 * obvious thing — reports the proxy warning and swallows "you need to set
 * CLOUDFLARE_API_TOKEN".
 */
function wranglerMessage(error) {
  const stdout = String(error.stdout || '');
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(start));
      if (parsed?.error?.text) return parsed.error.text;
    } catch {
      // Not JSON after all; fall through to the raw output.
    }
  }
  return String(error.stderr || stdout || error.message).trim();
}

async function d1(command, { remote }) {
  const args = [
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    remote ? '--remote' : '--local',
    '--json',
    '--command',
    command,
  ];

  let stdout;
  try {
    ({ stdout } = await run('bunx', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    // execFile's own message is just "Command failed", which says nothing
    // about what was refused.
    throw new Error(`wrangler could not run:\n  ${command}\n\n${wranglerMessage(error)}`);
  }

  // wrangler prints a banner on some versions even with --json.
  const start = stdout.indexOf('[');
  const parsed = JSON.parse(start > 0 ? stdout.slice(start) : stdout);
  return parsed.flatMap((batch) => batch.results ?? []);
}

/**
 * Tables that are D1's business rather than ours.
 *
 * `_cf_METADATA` and friends are Cloudflare's bookkeeping and are not always
 * even readable — a `PRAGMA table_info` on one fails outright. `d1_migrations`
 * is wrangler's, and is read separately below.
 */
const INTERNAL_TABLES = /^(sqlite_|_cf_|_litestream)/;

/**
 * The live schema, via wrangler. Same shape as `readSchema`.
 *
 * One query for the columns of every table: `pragma_table_info` as a
 * table-valued function joins against `sqlite_master`, and a wrangler
 * invocation per table is thirty-odd process launches for the same answer.
 * Not every SQLite build exposes it that way, so there is a slower path.
 *
 * `exec` is the way out to the database, and is injected so the shape of this
 * — which internal tables are skipped, which query is tried first — can be
 * tested without a D1 to point at.
 */
export async function readLiveSchema(options, exec = d1) {
  const objects = await exec(`SELECT type, name, sql FROM sqlite_master`, options);

  const indexes = new Map();
  for (const object of objects) {
    if (object.type === 'index' && object.sql) indexes.set(object.name, object.sql);
  }

  const names = objects
    .filter((object) => object.type === 'table' && !INTERNAL_TABLES.test(object.name))
    .map((object) => object.name);

  const tables = new Map(names.map((name) => [name, new Map()]));
  const add = (table, column) => {
    tables.get(table)?.set(column.name, {
      name: column.name,
      type: column.type,
      notNull: Boolean(column.notnull),
      default: column.dflt_value,
      pk: Boolean(column.pk),
    });
  };

  try {
    const rows = await exec(
      `SELECT m.name AS "table", p.name AS "name", p.type AS "type", ` +
        `p."notnull" AS "notnull", p.dflt_value AS "dflt_value", p.pk AS "pk" ` +
        `FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`,
      options,
    );
    for (const row of rows) add(row.table, row);
    if ([...tables.values()].every((columns) => columns.size === 0)) throw new Error('no columns');
    return { tables, indexes };
  } catch {
    // Fall through to asking one table at a time.
  }

  for (const name of names) {
    try {
      for (const column of await exec(`PRAGMA table_info(\`${name}\`)`, options)) {
        add(name, column);
      }
    } catch (error) {
      console.log(`  ${name}: could not be read (${error.message.split('\n')[0]})`);
    }
  }

  return { tables, indexes };
}

async function readRecordedMigrations(options) {
  try {
    const rows = await d1(`SELECT name FROM d1_migrations`, options);
    return new Set(rows.map((row) => row.name));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  const remote = process.argv.includes('--remote');
  const apply = process.argv.includes('--apply');
  const options = { remote };

  console.log(`Comparing ${DATABASE} (${remote ? 'remote' : 'local'}) with migrations/\n`);

  const expected = await schemaFromMigrations();
  const live = await readLiveSchema(options);
  const diff = diffSchemas(expected, live);
  const recorded = await readRecordedMigrations(options);
  const files = await migrationFiles();

  const repairs = [];
  const unrepairable = [];

  for (const table of diff.missingTables) {
    unrepairable.push(`\`${table}\` is missing entirely — run the migrations.`);
  }

  const byTable = new Map();
  for (const missing of diff.missingColumns) {
    if (!byTable.has(missing.table)) byTable.set(missing.table, []);
    byTable.get(missing.table).push(missing.column.name);
    const sql = addColumnSql(missing);
    if (sql) repairs.push(sql);
    else
      unrepairable.push(
        `\`${missing.table}\`.\`${missing.column.name}\` cannot be added in place ` +
          `(${missing.column.pk ? 'primary key' : 'NOT NULL with no default'}).`,
      );
  }

  for (const [table, columns] of byTable) {
    console.log(`  ${table}: missing ${columns.length} column(s) — ${columns.join(', ')}`);
  }
  for (const index of diff.missingIndexes) {
    console.log(`  index ${index.name}: missing`);
    const guarded = index.sql.replace(/^CREATE (UNIQUE )?INDEX /i, 'CREATE $1INDEX IF NOT EXISTS ');
    repairs.push(`${guarded};`);
  }
  for (const extra of diff.extraColumns) {
    console.log(
      `  ${extra.table}.${extra.column}: present live, absent from migrations (left alone)`,
    );
  }

  const unrecorded = recorded ? files.filter((file) => !recorded.has(file)) : [];
  const orphaned = recorded ? [...recorded].filter((name) => !files.includes(name)) : [];

  if (recorded === null) {
    console.log('\n  d1_migrations could not be read — skipping the bookkeeping check.');
  } else if (unrecorded.length || orphaned.length) {
    console.log('\nMigration bookkeeping:');
    for (const name of orphaned) {
      console.log(`  recorded but no longer on disk: ${name} (renamed?)`);
    }
    for (const name of unrecorded) {
      console.log(`  on disk but not recorded: ${name} — WILL BE RE-RUN by the next apply`);
    }
  }

  if (!repairs.length && !unrepairable.length && !unrecorded.length) {
    console.log('  In step. Nothing to repair.');
    return;
  }

  const bookkeeping = unrecorded.map(recordMigrationSql);

  if (repairs.length || bookkeeping.length) {
    console.log('\nRepair SQL:\n');
    for (const sql of [...repairs, ...bookkeeping]) console.log(`${sql}\n`);
  }
  if (unrepairable.length) {
    console.log('Needs more than a repair:');
    for (const line of unrepairable) console.log(`  ${line}`);
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to execute the repair SQL above.');
    return;
  }

  for (const sql of [...repairs, ...bookkeeping]) {
    console.log(`applying: ${sql.split('\n')[0]}`);
    await d1(sql, options);
  }
  console.log('\nDone. Re-run without --apply to confirm.');
}

if (process.argv[1] && process.argv[1].endsWith('d1-drift.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
