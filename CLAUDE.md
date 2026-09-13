# Working in this repository

## Database migrations

**Every `CREATE` in a migration must be `CREATE ... IF NOT EXISTS`, and every
`DROP` must be `DROP ... IF EXISTS`.** This covers tables, indexes (including
unique ones), views and triggers.

drizzle-kit does not emit them that way, so `bun run db:generate` runs
`scripts/idempotent-migrations.mjs` immediately after generating, which
rewrites them in place. If you write or edit a migration by hand, run
`bun run db:idempotent`. `tests/migrations.test.ts` fails the build if anything
in `migrations/` is left in the bare form.

Why: wrangler decides what to apply by **filename**, comparing `migrations/`
against the names recorded in the `d1_migrations` table. Anything whose name it
does not recognise is run in full. A bare `CREATE TABLE` then aborts the entire
migration on the first object that already exists.

### The limit of that rule

SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — re-adding a column
is a hard `duplicate column name`, and there is no syntax that avoids it. Since
most migrations after the first are `ADD COLUMN`, the guards make a re-applied
migration fail *later* rather than not at all. Do not try to invent syntax for
this; the rule below is what actually prevents it.

### Never rename or renumber an applied migration

Once a migration has been applied anywhere — a teammate's local D1, preview,
production — its filename is its identity, and changing it makes wrangler run
it again from the top against a database that already has it.

When two branches both add, say, `0002_*.sql` and have to be merged, renumbering
one of them is unavoidable. When that happens, say so in the merge commit, and
tell anyone with an existing database to record the new name as already applied
rather than let it re-run:

```sql
INSERT INTO d1_migrations (name, applied_at)
SELECT '0010_growth_engine.sql', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0010_growth_engine.sql');
```

For a local database that holds nothing worth keeping, deleting it and
re-migrating from scratch is simpler and safer.

### Adding a migration

`bun run db:generate` after editing `src/lib/db/schema.ts`. It writes the SQL,
the snapshot under `migrations/meta/`, and the journal entry, then applies the
guards. Do not hand-edit `migrations/meta/` — if a snapshot has drifted from
the schema, `bunx drizzle-kit generate` reporting "No schema changes" is the
check that it is back in step.

## Verifying a change

- `bun run test` — vitest, no database required.
- `bun run typecheck` and `bun run typecheck:agent`.
- `bun run build` — includes `scripts/wrap-worker.mjs`, which adds the
  `scheduled()` handler the cron triggers need.
