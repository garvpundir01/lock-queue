# Lock Queue

Reads a PostgreSQL migration and works out what it does to a table that is being used.

```
node src/test.mjs        # 109 engine tests
open dist/index.html     # the tool (no build step, no dependencies)
```

## The problem

The outage nobody plans for is not a slow migration. It is the queue.

`ALTER TABLE` needs an `ACCESS EXCLUSIVE` lock. To get it, it waits for whatever is
already running on that table. While it waits, **every query that arrives after it waits
too** — including plain `SELECT`s that the migration would never have touched. A 200ms
migration sitting behind one five-minute analytics query blocks the entire table for five
minutes.

This is why `lock_timeout` matters more than migration speed, and why "it ran fine in
staging" tells you nothing: staging has no concurrent traffic to queue up.

## What it reports

For every statement: the lock it takes, what that lock blocks, whether the work is a
table rewrite, a sequential scan, an index build or a catalog-only change, and how long
it holds the lock at your row count.

For the script as a whole, three faults that come from arrangement rather than from any
single statement:

- **No `lock_timeout`** before taking a strong lock — the cascade above.
- **`CONCURRENTLY` inside a transaction block** — Postgres rejects this outright, so the
  migration dies partway through.
- **Several strong locks in one transaction** — a lock taken inside a transaction is held
  until `COMMIT`, not released when the statement ends. Three 10-second statements block
  the table for 30 seconds, not 10.

## What makes it different

Squawk, `strong_migrations` and Atlas all exist and all lint migrations. They tell you a
statement is unsafe. This does three things they don't:

1. **Computes the blast radius.** "Blocks writes for about 12 seconds at 12M rows" is a
   decision you can make. "This is unsafe" is not.
2. **Writes the rewrite.** Not a link to a blog post — the actual multi-step SQL, with
   your table and column names already in it, ready to run.
3. **Explains the queue.** The mechanism above is the reason migrations cause outages,
   and it is absent from every linter's output.

The checks themselves are not the moat; anyone can encode them. What compounds is the
rewrite library — every migration shape that has a safe equivalent, and the exact SQL for
it, across Postgres versions.

## Examples of what it catches

| Statement | What actually happens | The rewrite |
|---|---|---|
| `ADD COLUMN ... DEFAULT now()` | Full table rewrite. A *constant* default is catalog-only since PG 11; a volatile one is evaluated per row. | Add the column, set the default, backfill in batches |
| `ALTER COLUMN id TYPE bigint` | Full rewrite plus every index on the column. Looks like a widening, isn't. | New column, backfill, swap names |
| `SET NOT NULL` | Sequential scan holding `ACCESS EXCLUSIVE` | `CHECK ... NOT VALID`, `VALIDATE`, then `SET NOT NULL` — PG 12+ accepts it instantly |
| `CREATE INDEX` | `SHARE` lock; every write waits for the whole build | `CREATE INDEX CONCURRENTLY`, outside a transaction |
| `ADD FOREIGN KEY` | Scans, and locks the referenced table too | `NOT VALID`, then `VALIDATE CONSTRAINT` |
| `ADD CONSTRAINT ... UNIQUE` | Builds the index under `ACCESS EXCLUSIVE` | `CREATE UNIQUE INDEX CONCURRENTLY`, then `USING INDEX` |
| `ADD COLUMN ... NOT NULL` (no default) | Errors outright on a non-empty table | Give it a constant default |
| `UPDATE` with no `WHERE` | Row locks held until commit; bloat | Batch it |

## Layout

```
src/engine.js    statement splitting, classification, lock table, estimates
src/test.mjs     109 tests
dist/index.html  the tool, self-contained
```

The splitter handles the three things that make splitting on `;` wrong: string literals,
comments, and dollar-quoted bodies (`$$ ... $$` and `$tag$ ... $tag$`). The engine has no
DOM and no network calls, so the same logic runs in CI against a migrations directory.

## Limits

- **Estimates, not predictions.** Roughly 500k rows/sec for a rewrite, 2M for a scan, 1M
  for an index build. Row width, disk and cache move these substantially. They are for
  telling "instant" from "minutes".
- **Pattern-based, not a parser.** It recognises the shapes migrations take. Anything it
  does not recognise is listed and left unjudged rather than guessed at.
- **Postgres 11+ assumed.** Constant defaults are catalog-only from 11; `SET NOT NULL`
  can lean on a validated `CHECK` from 12.
- It reads one table size for the whole script rather than per-table statistics.
