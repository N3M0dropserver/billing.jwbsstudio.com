# When the database and the migrations disagree

A growth run failed in September 2026 with this, and nothing else:

```
Error: Failed query: insert into "prospects" ("id", "user_id", "campaign_id", … ,
"scale_score", "scale", "brand", "branch_count", …) values (?, ?, ?, …)
params: 01M2FBQ98597PTCFRN0YDV4GXW,01M29YA3XT155TWT06GZZJCV3D,…
```

The actual reason was one line long and was not in there: **`table prospects has
no column named scale_score`**. This is the write-up of how a production
database came to be missing four columns that migration `0011` adds, and what
to do about it.

## What happened

`0010_growth_engine.sql` was written and applied as `0002_growth_engine.sql`.
`0011_scale_and_ai_observability.sql` was `0003_scale_and_ai_observability.sql`.
Both were renumbered when the branch was merged, because the trunk had grown
its own `0002` and `0003` in the meantime.

wrangler decides what to apply by **filename**, against the names recorded in
`d1_migrations`. A database that had already applied `0002_growth_engine.sql`
has never heard of `0010_growth_engine.sql`, so the next
`wrangler d1 migrations apply` ran it again, from the top.

Migration `0010` rebuilds `prospects` — SQLite cannot add a foreign key in
place, so drizzle emits the standard dance:

```sql
CREATE TABLE IF NOT EXISTS `__new_prospects` (…);   -- the 2026-era shape
INSERT INTO `__new_prospects`(…20 columns…) SELECT …20 columns… FROM `prospects`;
DROP TABLE IF EXISTS `prospects`;
ALTER TABLE `__new_prospects` RENAME TO `prospects`;
```

Run a second time, every one of those succeeds. The guards that make a
re-applied migration survivable are what let it get that far: the CREATEs and
DROPs no longer abort, so the rebuild reaches a `prospects` that `0011` has
since added four columns to, and replaces it with the shape `0010` knew about.
The copy names twenty columns, so `campaign_id`, `domain`, `source`, the
scores, `stage` and `selected` were blanked on every existing row as well.

`0010` then aborted on `ALTER TABLE proposals ADD campaign_id` —
`duplicate column name` — so it was never recorded as applied, and it will do
the same thing again on the next apply.

`0011` re-ran too, and aborted on `ALTER TABLE campaigns ADD scale_ceiling`,
which is fourteen statements before the four `ALTER TABLE prospects ADD` it
would have needed to put things back.

## Fixing a database this has happened to

```sh
bun run db:drift --remote            # what is missing, and the SQL to add it
bun run db:drift --remote --apply    # add it
```

Both halves matter. The columns come back with `ALTER TABLE … ADD`, and the
migration names get recorded so that the next `migrations apply` stops
re-running migrations the database already has:

```sql
INSERT INTO d1_migrations (name, applied_at)
SELECT '0010_growth_engine.sql', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0010_growth_engine.sql');
```

Run the check without `--apply` first and read what it proposes. It only ever
adds — a column present in the database and absent from the migrations is
reported and left alone.

Data that the rebuild blanked is not recoverable from the database; the
prospects of an affected campaign have lost their `campaign_id` and their
scores and are best discovered again.

## Keeping it from happening again

1. **Never renumber or rename an applied migration.** This is the rule in
   CLAUDE.md and it is the only thing that prevents the re-run outright. When a
   merge forces it, record the new name in `d1_migrations` on every database
   that has the old one, *before* the next apply.
2. **Order statements so a re-run dies early.** Within a migration, every
   `ALTER TABLE … ADD COLUMN` goes before any table rebuild. SQLite has no
   `ADD COLUMN IF NOT EXISTS`, so those statements are the only ones that
   reliably refuse to run twice — putting them first turns a re-run into a
   harmless abort instead of a silent rebuild. `0010` is ordered this way, and
   `tests/migrations.test.ts` re-applies every migration to an already-migrated
   database and fails if a column disappears.
3. **`bun run db:drift` after any migration that had to be renumbered**, local
   and remote.
