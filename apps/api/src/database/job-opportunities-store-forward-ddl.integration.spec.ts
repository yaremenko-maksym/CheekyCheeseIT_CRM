/**
 * The production forward DDL of the `job_opportunities` store (r5 Task 1.3a) produces
 * the SAME catalog as `drizzle-kit push` of the Drizzle schema — and applying it twice
 * changes nothing.
 *
 * Why this spec exists at all
 * ---------------------------
 * The store has TWO descriptions: `src/database/schema/job-{opportunities,collection,
 * metering,queue}.ts`, which is what dev and CI get through `db:push`, and
 * `drizzle/manual/2026-10-17_job_opportunities_store{,_indexes}.sql`, which is what
 * PRODUCTION gets — the prod image does not ship drizzle-kit. Nothing in the build
 * relates the two. A missing CHECK, a partial index whose predicate drifted, an FK with
 * `ON DELETE SET NULL` where the schema says `RESTRICT`: every one of those passes
 * typecheck, passes the unit suite, passes the `db:push` CI job, and is discovered on
 * production, where the only remedy is another hand-written migration. So the
 * comparison is done by EXECUTION, here, on every integration run.
 *
 * WHERE THE EXPECTED SET COMES FROM, AND WHY IT MATTERS (CR-M-1 / SPEC-M-1)
 * -------------------------------------------------------------------------
 * The first revision of this spec parsed its object list out of the SQL files and then
 * filtered the reference side by those same names. Code review and spec review found the
 * consequence independently: an object left out of the SQL shrinks BOTH sides together.
 * Measured on this branch before the fix, by deleting one object at a time from the SQL:
 *   - a missing CHECK on `job_sources`  -> spec GREEN. The hole, fully unprotected.
 *   - a missing table / `job_sources` column / index -> RED, but only because a
 *     hand-maintained count constant (18/18/44) happened to disagree. Counts catch a
 *     shrink; they do not catch a SWAP, and they are correct only while someone keeps
 *     updating them.
 *   - a missing enum -> the apply itself fails, because a column declares the type.
 * So nothing here is derived from the file under test any more:
 *   - WHICH objects belong to the store comes from the Drizzle schema sources (the
 *     `pgTable(…)` / `pgEnum(…)` declarations in the four store modules and
 *     `enums.ts`) plus a hardcoded record of what `job_sources` looked like BEFORE this
 *     store, which is a historical fact that cannot change;
 *   - WHAT each object should look like comes from `public`, built by `db:push`.
 * An object missing from the SQL is therefore an object the reference has and the
 * candidate does not — a difference, not a shared blind spot. The four red runs proving
 * that are recorded in the PR.
 *
 * What it compares
 * ----------------
 * Both sides are real databases, not metadata read twice:
 *   * `public` — built by `db:push` from the Drizzle schema (CI runs it before the
 *     integration suite; `assertRealDbSchema` below fails loudly if it did not);
 *   * an isolated schema — built by applying the two forward SQL files, statement by
 *     statement, exactly as `psql < file` would.
 * Then: enum types with their VALUE ORDER, columns with type / nullability / default /
 * identity / generated / collation / position, constraints with their full definition
 * (which is where FK actions and CHECK expressions live) and their validated state, and
 * indexes with their full definition (which is where `DESC NULLS LAST`, a partial
 * predicate and `NULLS NOT DISTINCT` live), plus `indisvalid` so a half-built concurrent
 * index is a failure and not a silent pass.
 *
 * Why an isolated schema and not a second database
 * ------------------------------------------------
 * Same reason as `user-locale-migration.integration.spec.ts`: `public` already HAS the
 * store (that is the reference side), so applying the files there would create nothing
 * and prove nothing. The isolated schema is what makes the forward SQL actually run.
 * It is possible only because no statement in those files is schema-qualified — see the
 * note on the foreign keys in part 1's header.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitSqlStatements } from './manual-sql-statements'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import {
  dropRolesCreated,
  existingDeployRoles,
  installDeployRoles,
} from './__test-helpers__/deploy-ddl-preconditions'

const MANUAL_DIR = join(__dirname, '..', '..', 'drizzle', 'manual')
const SCHEMA_DIR = join(__dirname, 'schema')
const PART_1 = '2026-10-17_job_opportunities_store.sql'
const PART_2 = '2026-10-17_job_opportunities_store_indexes.sql'
/**
 * SR-M-4. The ALTER-shaped path for a store that is ALREADY deployed (r5 Task
 * 1.4b-ii: the REASON_REDACTED evidence row). Before this const existed the
 * part list was PART_1 + PART_2 and nothing in the repository applied this file
 * at all — so the two paths could drift apart, one of them be changed and the
 * other not, and no test anywhere would notice. The reviewer measured them
 * byte-identical on the day it was written, which is exactly why it is pinned
 * now, while that is still true: a missing pin is cheapest to add before it has
 * a divergence to report.
 */
const PART_3_MIGRATION = '2026-10-21_job_queue_reason_redacted.sql'
/**
 * r5 Task 1.4b-iii. The upgrade file for the redaction becoming callable. The part of it
 * this spec can see is the table half: `ck_job_queue_actions_redaction_reason_null`
 * (SR-M-5 of PR #1075), which part 1 declares inline in `CREATE TABLE IF NOT EXISTS` and
 * which therefore reaches a deployed database ONLY through this file. Its function half
 * (the redaction's new signature) is pinned against the triggers file in
 * `job-queue-append-only.integration.spec.ts`.
 */
const PART_4_MIGRATION = '2026-10-22_job_queue_redaction_callable.sql'
/**
 * r5 Task 2.5 T1. `job_collection_runs.account_key` and the two single-flight indexes
 * (`uq_job_collection_runs_one_started_per_{source,account}`) are declared in Drizzle,
 * so the `db:push` reference carries them, and production gets them ONLY through this
 * file. It is therefore part of every forward path below — applied after parts 1 and 2,
 * as `deploy.yml` will apply it — and on a fresh store it is a REAL upgrade: parts 1 and
 * 2 create `job_collection_runs` without the column, and this file adds it.
 */
const PART_5_MIGRATION = '2026-10-24_job_run_single_flight.sql'
/** The indexes PART_5 creates; the reference counts them beside part 2's own. */
const PART_5_INDEXES = [
  'uq_job_collection_runs_one_started_per_account',
  'uq_job_collection_runs_one_started_per_source',
] as const
const REDACTION_REASON_NULL = 'ck_job_queue_actions_redaction_reason_null'
const SCHEMA = 'ddl_job_opportunities_store'
/** Its own schema, so the migration path cannot disturb the fresh-path comparison. */
const MIGRATION_SCHEMA = 'ddl_job_queue_reason_redacted_alter'
const CONFIG_GUARD_SCHEMA = 'ddl_job_sources_config_guard'
/** A non-superuser used to reproduce the masked-progress-row case (SR-M-4). */
const UNPRIVILEGED_ROLE = 'ddl_forward_ddl_probe'
/** Two indexes on one table, so "a build on the same table" is expressible. */
const PARKABLE_TABLE = 'job_opportunities'
const PARKED_INDEX = 'idx_job_opportunities_availability'
const OTHER_INDEX_SAME_TABLE = 'idx_job_opportunities_candidate_key'

/** The Drizzle modules that, between them, declare exactly this store's tables. */
const STORE_MODULES = [
  'job-opportunities.ts',
  'job-collection.ts',
  'job-metering.ts',
  'job-queue.ts',
]

/**
 * `job_sources` as production had it BEFORE this store — the one thing here that is
 * hardcoded, because it is the one thing neither side can supply: the reference
 * (`public`) carries the EXTENDED table, and deriving the split from the SQL under test
 * is the circularity this whole section exists to remove. It is a historical fact, taken
 * from a `db:push` of the tree at `fdcb4325` (the parent of #1011), so it cannot drift:
 * what production had in October 2026 is settled. If a future task adds a column to
 * `job_sources` OUTSIDE this store, it belongs in these lists.
 */
const PRE_STORE_JOB_SOURCES_COLUMNS = [
  'id',
  'type',
  'config',
  'enabled',
  'last_collected_at',
  'budget_limit',
  'budget_window',
  'budget_used',
  'budget_window_started_at',
  'trigger_mode',
  'min_interval_hours',
  'disabled_reason',
  'created_at',
  'updated_at',
] as const
const PRE_STORE_JOB_SOURCES_CONSTRAINTS = ['job_sources_pkey', 'uq_job_sources_type_config']
const PRE_STORE_JOB_SOURCES_INDEXES = ['job_sources_pkey', 'uq_job_sources_type_config']

/**
 * The `job_*` enum types that predate this store. `enums.ts` declares 27 in total; these
 * 8 are older, which is what leaves the 19 the forward DDL creates. (That arithmetic is
 * also the correct explanation of the "~27" figure in the original task brief.)
 */
const PRE_STORE_ENUMS = [
  'job_exclusion_kind',
  'job_posting_signal_kind',
  'job_queue_status',
  'job_seniority',
  'job_source_budget_window',
  'job_source_trigger_mode',
  'job_source_type',
  'job_suggestion_status',
]

/** Tripwires on the DERIVED expectation — they fail if the reference side shifts. */
const EXPECTED = { tables: 18, enums: 19, jobSourcesColumns: 18, indexes: 44 } as const

const readPart = (name: string): string => readFileSync(join(MANUAL_DIR, name), 'utf8')

/**
 * Membership, read off the Drizzle declarations rather than the SQL under test. Textual
 * on purpose: importing the four modules directly (rather than through the `./schema`
 * barrel) trips the finance/transactions circular initialisation, and the barrel cannot
 * say WHICH of its 67 tables belong to this store. The `pgTable('name'` form is uniform
 * across the codebase, and the count assertion below makes a parse failure loud.
 */
function declaredStoreTables(): string[] {
  const names = new Set<string>()
  for (const file of STORE_MODULES) {
    const source = readFileSync(join(SCHEMA_DIR, file), 'utf8')
    for (const match of source.matchAll(/pgTable\(\s*'([a-z_0-9]+)'/g)) names.add(match[1]!)
  }
  return [...names].sort()
}

/** Every `job_*` enum the Drizzle schema declares, minus the ones that predate the store. */
function declaredStoreEnums(): string[] {
  const source = readFileSync(join(SCHEMA_DIR, 'enums.ts'), 'utf8')
  const all = new Set<string>()
  for (const match of source.matchAll(/pgEnum\(\s*'(job_[a-z_0-9]+)'/g)) all.add(match[1]!)
  return [...all].filter((name) => !PRE_STORE_ENUMS.includes(name)).sort()
}

const STORE_TABLES = declaredStoreTables()
const STORE_ENUMS = declaredStoreEnums()

/**
 * How a column's ordinal position is compared. Shared with the test that pins it, so
 * reverting it to a raw `attnum` fails there (CR-L-8) — `attnum` values are never
 * reused, so any catalog that has ever dropped a column carries gaps that a fresh
 * `db:push` does not, and comparing the raw number would fail on a developer's
 * long-lived database while CI stayed green. The RANK is what carries meaning.
 */
const POSITION_EXPRESSION = `CASE
              WHEN c.relname = 'job_sources' THEN NULL
              ELSE row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum)
            END`

type Row = Record<string, unknown>
type Catalog = { enums: Row[]; columns: Row[]; constraints: Row[]; indexes: Row[] }

/**
 * `pg_get_constraintdef` / `pg_get_indexdef` / `format_type` schema-qualify a name that
 * is not visible in the reading session's `search_path`, so the same object renders
 * differently depending on which side it is read from. Erase the schema prefix on both
 * sides and what remains is comparable.
 */
const unqualify = (text: string, schema: string): string =>
  text.split(`"${schema}".`).join('').split(`${schema}.`).join('')

/**
 * The catalog of the store's objects in one schema, restricted by the membership lists
 * above — never by anything the SQL under test says.
 */
async function readCatalog(client: PoolClient, schema: string): Promise<Catalog> {
  const enums = await client.query(
    `SELECT t.typname AS name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = ANY($2::text[])
      ORDER BY t.typname, e.enumsortorder`,
    [schema, STORE_ENUMS],
  )

  // CR-L-2: identity, generated, collation and ordinal position are compared too.
  // Position is compared only for the store's OWN tables, where both sides are built by
  // a single `CREATE TABLE`: on `job_sources` the reference gets the new columns inside
  // its `CREATE TABLE` while the candidate appends them with `ALTER TABLE`, so the
  // physical order legitimately differs there and carries no meaning either way.
  // CR-L-4: the DENSE rank of `attnum`, not `attnum` itself. A raw `attnum` differs
  // between two catalogs that agree on everything observable as soon as one of them has
  // ever had a column dropped — `attnum` values are never reused — so comparing it would
  // fail on a developer's long-lived database while CI, which is always freshly pushed,
  // stayed green. The rank compares the ORDER, which is the only part that means
  // anything, and is identical whatever the gaps.
  const columns = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr,
            a.attidentity AS identity,
            a.attgenerated AS generated,
            coalesce(co.collname, '') AS collation,
            ${POSITION_EXPRESSION} AS position
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (c.relname = ANY($2::text[])
             OR (c.relname = 'job_sources' AND NOT (a.attname = ANY($3::text[]))))
      ORDER BY c.relname, a.attname`,
    [schema, STORE_TABLES, PRE_STORE_JOB_SOURCES_COLUMNS],
  )

  const constraints = await client.query(
    `SELECT c.relname AS table_name, con.conname AS name, con.contype AS kind,
            pg_get_constraintdef(con.oid) AS definition, con.convalidated AS validated
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND (c.relname = ANY($2::text[])
             OR (c.relname = 'job_sources' AND NOT (con.conname = ANY($3::text[]))))
      ORDER BY c.relname, con.conname`,
    [schema, STORE_TABLES, PRE_STORE_JOB_SOURCES_CONSTRAINTS],
  )

  const indexes = await client.query(
    `SELECT c.relname AS table_name, ic.relname AS name,
            pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND (c.relname = ANY($2::text[])
             OR (c.relname = 'job_sources' AND NOT (ic.relname = ANY($3::text[]))))
      ORDER BY c.relname, ic.relname`,
    [schema, STORE_TABLES, PRE_STORE_JOB_SOURCES_INDEXES],
  )

  // CR-L-2: table-level storage and policy flags, folded into the column rows so a
  // single comparison covers them. `relpersistence` would catch an UNLOGGED table (a
  // plausible hand-written slip that loses the table on crash recovery) and
  // `relrowsecurity` an RLS difference, which matters once 1.3b/1.3c land.
  const relFlags = await client.query(
    `SELECT c.relname AS table_name, c.relpersistence AS persistence,
            c.relrowsecurity AS row_security, c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
      ORDER BY c.relname`,
    [schema, STORE_TABLES],
  )

  const scrub = (rows: Row[], field: string): Row[] =>
    rows.map((r) => ({ ...r, [field]: unqualify(String(r[field]), schema) }))

  return {
    enums: enums.rows,
    columns: [...scrub(columns.rows, 'data_type'), ...relFlags.rows],
    constraints: scrub(constraints.rows, 'definition'),
    indexes: scrub(indexes.rows, 'definition'),
  }
}

/**
 * Part 2's INVALID-index sweep on its own. Needed because the sweep must be exercised
 * under a role that could not run the rest of the file, and because a test about the
 * sweep should fail on the sweep rather than on an unrelated statement.
 */
function part2Blocks(): { sweep: string; finalCheck: string } {
  const blocks = readPart(PART_2).match(/DO \$\$\nDECLARE[\s\S]*?\nEND \$\$;/g)
  if (blocks?.length !== 2) {
    throw new Error(`expected 2 DO blocks in ${PART_2}, found ${blocks?.length ?? 0}`)
  }
  return { sweep: blocks[0]!, finalCheck: blocks[1]! }
}

/**
 * Parks a `CREATE INDEX CONCURRENTLY` in its "waiting for old snapshots" phase, which
 * is the state where the index row EXISTS with `indisvalid = false` while a build is
 * genuinely in progress — the state the sweep has to tell apart from an abandoned
 * leftover.
 *
 * Deterministic, and not a timing trick: a concurrent build must wait out every
 * transaction holding a snapshot older than its own, so a third session sitting in
 * REPEATABLE READ parks it for as long as that session lives, whatever the table size.
 * Returns the handles the caller must settle.
 */
async function parkConcurrentBuild(
  pool: Pool,
  indexName: string,
): Promise<{ release: () => Promise<void> }> {
  const holder = await pool.connect()
  const builder = await pool.connect()
  await builder.query(`SET search_path TO ${SCHEMA}`)
  await holder.query(`SET search_path TO ${SCHEMA}`)

  // The definition is taken from the REFERENCE catalog, never written out here: an
  // approximation of it would rebuild the index with the wrong columns and leave the
  // schema silently diverged for every test that runs afterwards. (It did, once.)
  const definition = await holder.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND ic.relname = $1`,
    [indexName],
  )
  if (definition.rowCount !== 1) {
    throw new Error(`no reference definition for index ${indexName}`)
  }
  // Only the `ON public.<table>` qualification is rewritten — not every occurrence of the
  // string anywhere in the definition, which would also hit a predicate or an operator
  // class that happened to name the schema (CR-L-10).
  const create = String(definition.rows[0]['def'])
    .replace(
      /^CREATE (UNIQUE )?INDEX /,
      (_m, unique) => `CREATE ${unique ?? ''}INDEX CONCURRENTLY `,
    )
    .replace(/ ON public\./, ' ON ')

  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await holder.query(`SELECT count(*) FROM ${PARKABLE_TABLE}`)

  // Deliberately not awaited: this call does not return until the holder commits.
  const building = builder.query(create).catch((error: Error) => {
    // Surfaced by the assertions on the index's state; swallowing here keeps an
    // expected cancellation from becoming an unhandled rejection.
    return error
  })

  // Polled through the POOL, never through `holder`: the holder is sitting in a
  // REPEATABLE READ transaction, so its view of `pg_index` is frozen at a snapshot taken
  // before the build existed and it can never see the new index row. (It cost a run to
  // learn that `pg_stat_progress_create_index` is NOT frozen — it reads shared memory —
  // so the progress count moved while the catalog lookup stayed empty forever.)
  const deadline = Date.now() + 20_000
  for (;;) {
    const progress = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_progress_create_index
        WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )
    const index = await pool.query(
      `SELECT i.indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [SCHEMA, indexName],
    )
    if (
      progress.rows[0]['n'] > 0 &&
      index.rowCount === 1 &&
      index.rows[0]['indisvalid'] === false
    ) {
      break
    }
    if (Date.now() > deadline) {
      // CR-L-9: the ROLLBACK first, so the build can finish, then AWAIT it before either
      // client goes back to the pool. Releasing a client whose query is still running
      // hands a busy connection to the next caller, and the failure surfaces somewhere
      // unrelated — which is the worst way for a timeout path to fail.
      await holder.query('ROLLBACK').catch(() => undefined)
      await building
      holder.release()
      builder.release()
      throw new Error(`build of ${indexName} did not park within 20s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return {
    release: async () => {
      await holder.query('COMMIT').catch(() => undefined)
      await building
      holder.release()
      builder.release()
    },
  }
}

/** Collects the server's NOTICEs for the duration of one call. */
async function withNotices<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<{ result: T; notices: string[] }> {
  const notices: string[] = []
  const listener = (message: { message?: string }): void => {
    if (message.message) notices.push(message.message)
  }
  client.on('notice', listener)
  try {
    const result = await run()
    return { result, notices }
  } finally {
    client.off('notice', listener)
  }
}

/**
 * Applies the named files statement by statement, the way `psql < file` would.
 *
 * The part list is a parameter because the sweep tests must apply PART 2 ALONE: part 1
 * takes a ShareRowExclusive lock on `job_opportunities` for each of its foreign keys
 * (an `ALTER TABLE … ADD CONSTRAINT` acquires the lock before the `duplicate_object`
 * guard can swallow anything), that conflicts with a concurrent index build on the same
 * table, and the file's own `lock_timeout` then correctly fails the apply. That is
 * right behaviour and has nothing to do with the sweep.
 */
async function applyParts(client: PoolClient, parts: readonly string[]): Promise<void> {
  for (const part of parts) {
    for (const statement of splitSqlStatements(readPart(part))) {
      try {
        await client.query(statement)
      } catch (error) {
        throw new Error(
          `${part}: statement failed\n--- statement ---\n${statement}\n--- error ---\n${
            (error as Error).message
          }`,
        )
      }
    }
  }
}

/**
 * The full forward path for the store as `deploy.yml` applies it. The name predates
 * PART_5 (Task 2.5 T1); it is kept so the history of the tests that call it reads on.
 */
const applyBothParts = (client: PoolClient): Promise<void> =>
  applyParts(client, [PART_1, PART_2, PART_5_MIGRATION])
const applyIndexesOnly = (client: PoolClient): Promise<void> => applyParts(client, [PART_2])

/**
 * Builds "production before this store" inside `schema`: the objects the forward DDL
 * depends on and does not create. Shapes are copied out of `public` rather than spelled
 * out here, so the stub cannot drift from the real catalogue and quietly weaken the
 * comparison; only the NAMES are stated, and those are historical.
 */
async function buildPreStoreStub(client: PoolClient, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query(`SET search_path TO ${schema}`)

  for (const typeName of PRE_STORE_ENUMS) {
    const labels = await client.query(
      `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = $1
        ORDER BY e.enumsortorder`,
      [typeName],
    )
    if (!labels.rowCount) {
      throw new Error(
        `[forward-ddl spec] public.${typeName} not found — the reference schema is ` +
          'unmigrated, so there is nothing to compare the forward DDL against.',
      )
    }
    const values = labels.rows.map((r: { enumlabel: string }) => `'${r.enumlabel}'`).join(', ')
    await client.query(`CREATE TYPE ${typeName} AS ENUM (${values})`)
  }

  // FK targets. Only `id` is referenced, so only `id` is stubbed; neither table is part
  // of the comparison.
  await client.query(`CREATE TABLE users (id uuid PRIMARY KEY)`)
  await client.query(`CREATE TABLE teams (id uuid PRIMARY KEY)`)

  const baseColumns = await client.query(
    `SELECT a.attname,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull,
            replace(coalesce(pg_get_expr(d.adbin, d.adrelid), ''), 'public.', '') AS default_expr
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = 'job_sources'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname = ANY($1::text[])
      ORDER BY a.attnum`,
    [PRE_STORE_JOB_SOURCES_COLUMNS],
  )
  if (baseColumns.rowCount !== PRE_STORE_JOB_SOURCES_COLUMNS.length) {
    throw new Error(
      `[forward-ddl spec] public.job_sources has ${baseColumns.rowCount} of the ` +
        `${PRE_STORE_JOB_SOURCES_COLUMNS.length} pre-store columns — the historical list ` +
        'in this spec no longer matches the reference schema.',
    )
  }
  const columnDdl = baseColumns.rows
    .map((r: { attname: string; data_type: string; attnotnull: boolean; default_expr: string }) => {
      const parts = [`"${r.attname}"`, r.data_type.replace(/^public\./, '')]
      if (r.default_expr) parts.push(`DEFAULT ${r.default_expr}`)
      if (r.attnotnull) parts.push('NOT NULL')
      return `  ${parts.join(' ')}`
    })
    .join(',\n')
  await client.query(`CREATE TABLE job_sources (\n${columnDdl}\n)`)

  const baseConstraints = await client.query(
    `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'job_sources'
        AND con.conname = ANY($1::text[])
      ORDER BY con.conname`,
    [PRE_STORE_JOB_SOURCES_CONSTRAINTS],
  )
  for (const row of baseConstraints.rows as Array<{ conname: string; definition: string }>) {
    await client.query(`ALTER TABLE job_sources ADD CONSTRAINT "${row.conname}" ${row.definition}`)
  }
}

let pool: Pool
let client: PoolClient
let reference: Catalog
let afterFirstApply: Catalog

describe.skipIf(!hasDatabaseUrl())('job_opportunities store forward DDL', () => {
  beforeAll(async () => {
    // The reference side is `db:push`'s output. If it is not there, this spec has
    // nothing to compare against — fail loudly rather than compare two empty sets.
    await assertRealDbSchema([
      { table: 'job_opportunities', column: 'employer_verified' },
      { table: 'job_queue_generation_entries', column: 'order_key' },
      { table: 'job_sources', column: 'manifest_id' },
    ])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    reference = await readCatalog(client, 'public')

    await buildPreStoreStub(client, SCHEMA)

    // SR-M-1: `ck_job_sources_config_bounded` is the ONE new CHECK that reads a column
    // this file does not add. With an empty table all 11 CHECKs validate against nothing,
    // which is how a validation failure on real rows stayed invisible to CI. These rows
    // make the validating ALTER actually scan data: a minimal object, a nested one, and
    // one close to the 8192-byte bound.
    await client.query(
      `INSERT INTO job_sources (type, config, enabled) VALUES
         ('DOU_RSS', '{}'::jsonb, true),
         ('REMOTEOK_API', '{"category":"devops","nested":{"a":[1,2,3]}}'::jsonb, false),
         ('REMOTIVE_API', jsonb_build_object('pad', repeat('x', 7000)), true)`,
    )

    await applyBothParts(client)
    afterFirstApply = await readCatalog(client, SCHEMA)

    // For the SR-M-4 test. NOINHERIT and no grants: it needs to be a role the session's
    // own role is not a member of, nothing more.
    await client.query(`DROP ROLE IF EXISTS ${UNPRIVILEGED_ROLE}`)
    await client.query(`CREATE ROLE ${UNPRIVILEGED_ROLE} NOSUPERUSER NOINHERIT NOLOGIN`)
  }, 180_000)

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${MIGRATION_SCHEMA} CASCADE`).catch(() => undefined)
    await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    await client
      ?.query(`DROP SCHEMA IF EXISTS ${CONFIG_GUARD_SCHEMA} CASCADE`)
      .catch(() => undefined)
    await client?.query(`DROP ROLE IF EXISTS ${UNPRIVILEGED_ROLE}`).catch(() => undefined)
    client?.release()
    await pool?.end()
  })

  it('derives its expectation from the Drizzle schema and the pushed catalog', () => {
    // The tripwires are on the DERIVED set now, not on the file under test: if the
    // Drizzle schema gains a table and the SQL does not, the count below fails and the
    // comparison that follows fails too.
    expect(STORE_TABLES).toHaveLength(EXPECTED.tables)
    expect(STORE_ENUMS).toHaveLength(EXPECTED.enums)

    const referenceJobSourcesColumns = reference.columns.filter(
      (r) => r['table_name'] === 'job_sources',
    )
    expect(referenceJobSourcesColumns).toHaveLength(EXPECTED.jobSourcesColumns)

    const constraintBacked = new Set(
      reference.constraints
        .filter((r) => r['kind'] === 'p' || r['kind'] === 'u')
        .map((r) => r['name']),
    )
    const standaloneIndexes = reference.indexes.filter((r) => !constraintBacked.has(r['name']))
    // Part 2's 44 plus the two Task 2.5 T1 adds through PART_5.
    expect(standaloneIndexes).toHaveLength(EXPECTED.indexes + PART_5_INDEXES.length)
    expect(standaloneIndexes.map((r) => r['name'])).toEqual(
      expect.arrayContaining([...PART_5_INDEXES]),
    )
  })

  it('creates NOTHING beyond the Drizzle set — the other direction (CR-L-5)', async () => {
    // Round 1 closed "an object missing from the SQL". This closes the converse: a table
    // or enum type the SQL creates that the Drizzle schema does not declare. Such an
    // object is invisible to every comparison above, because they are all restricted to
    // the expected set — and on production it would be a table nothing reads, or an enum
    // whose values no code knows, drifting from the schema from the day it lands.
    const tables = await client.query(
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [SCHEMA],
    )
    // The three stubs are what `buildPreStoreStub` creates to stand in for production.
    expect(tables.rows.map((r: { name: string }) => r.name)).toEqual(
      [...STORE_TABLES, 'job_sources', 'teams', 'users'].sort(),
    )

    const types = await client.query(
      `SELECT t.typname AS name FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 AND t.typtype = 'e' ORDER BY t.typname`,
      [SCHEMA],
    )
    expect(types.rows.map((r: { name: string }) => r.name)).toEqual(
      [...STORE_ENUMS, ...PRE_STORE_ENUMS].sort(),
    )
  })

  it('keeps the three copies of the index-name list in agreement (SR-M-6)', () => {
    // Part 2 names its 44 indexes THREE times: once per `CREATE INDEX CONCURRENTLY`, once
    // in the sweep's `ARRAY[…]`, and once in section 18's. Nothing but this test keeps
    // them equal. An index added to the creates and forgotten in the two arrays is
    // created, is compared against the reference, and passes everything — while being
    // invisible to the sweep (an interrupted build of it is never repaired) and to
    // section 18 (which therefore reports success). That is precisely the state section
    // 18 exists to prevent, reached through a copy-paste omission.
    //
    // The arrays cannot be factored into one place: every statement in that file has to
    // be independently applicable, so there is no temp table and no session state to
    // share a list through. Three copies is the design; this is the check that makes it
    // safe.
    const created = [
      ...readPart(PART_2).matchAll(
        /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS "([a-z_0-9]+)"/gm,
      ),
    ].map((m) => m[1]!)
    const { sweep, finalCheck } = part2Blocks()
    const quoted = (block: string): string[] =>
      [...block.matchAll(/^\s+'([a-z_0-9]+)',?$/gm)].map((m) => m[1]!)

    const sweepNames = quoted(sweep)
    const finalNames = quoted(finalCheck)

    // Sizes first, so a regex that silently matched nothing fails here rather than
    // comparing two empty sets.
    expect(created).toHaveLength(EXPECTED.indexes)
    expect(sweepNames).toHaveLength(EXPECTED.indexes)
    expect(finalNames).toHaveLength(EXPECTED.indexes)
    // No duplicates: a name listed twice would make the sizes agree while a different
    // name is missing.
    expect(new Set(created).size).toBe(created.length)
    expect(new Set(sweepNames).size).toBe(sweepNames.length)
    expect(new Set(finalNames).size).toBe(finalNames.length)

    expect(sweepNames.slice().sort()).toEqual(created.slice().sort())
    expect(finalNames.slice().sort()).toEqual(created.slice().sort())
  })

  it('keeps the three copies of the T1 index-name list in agreement (2.5 T1, same as SR-M-6)', () => {
    // PART_5 repeats part 2's device on a smaller scale: the creates, the sweep's
    // `ARRAY[…]` and the final check's `VALUES` each name its indexes, for the same
    // reason (every statement independently applicable), so the same drift is possible.
    const sql = readPart(PART_5_MIGRATION)
    const created = [
      ...sql.matchAll(/^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "([a-z_0-9]+)"/gm),
    ].map((m) => m[1]!)
    const sweepArray = /ARRAY\[([\s\S]*?)\]\)/.exec(sql)?.[1] ?? ''
    const sweepNames = [...sweepArray.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!)
    const finalNames = [...sql.matchAll(/\('(uq_[a-z_0-9]+)', '[a-z_]+'\)/g)].map((m) => m[1]!)

    // Sizes first, so a regex that matched nothing fails here, not as two equal empties.
    for (const list of [created, sweepNames, finalNames]) {
      expect(list.slice().sort()).toEqual([...PART_5_INDEXES])
    }
  })

  it('creates every enum type the Drizzle schema declares for the store, value order included', () => {
    // Order, not membership: `ALTER TYPE … ADD VALUE BEFORE/AFTER` and a fresh
    // `CREATE TYPE` can agree on the set and disagree on `enumsortorder`, and the order
    // is what every `ORDER BY <enum column>` in the application sorts on.
    expect(afterFirstApply.enums).toEqual(reference.enums)
    expect(new Set(afterFirstApply.enums.map((r) => r['name']))).toEqual(new Set(STORE_ENUMS))
  })

  it('creates every column the reference has, with the same type, default and nullability', () => {
    expect(afterFirstApply.columns).toEqual(reference.columns)
  })

  it('creates every constraint the reference has — CHECK expressions, FK actions, validated state', () => {
    // `convalidated` is compared on purpose: `ADD CONSTRAINT … NOT VALID` is a tempting
    // way to make a CHECK cheap to add, and it leaves the constraint unenforced for
    // every row that already exists.
    expect(afterFirstApply.constraints).toEqual(reference.constraints)
  })

  it('creates every index the reference has — partial predicates, NULLS NOT DISTINCT, sort order', () => {
    expect(afterFirstApply.indexes).toEqual(reference.indexes)
  })

  it('compares column ORDER in a way a dropped column cannot shift (CR-L-8)', async () => {
    // Two schemas with the SAME surviving columns, one of which once had a column in the
    // middle and dropped it — the shape of a developer's database after a schema change.
    // Raw `attnum` disagrees there; the rank does not. Without this, reverting
    // POSITION_EXPRESSION to `a.attnum` breaks nothing, because every other test runs
    // against a freshly pushed catalog that has no gaps.
    await client.query('DROP SCHEMA IF EXISTS pos_fresh CASCADE')
    await client.query('DROP SCHEMA IF EXISTS pos_dropped CASCADE')
    try {
      await client.query('CREATE SCHEMA pos_fresh')
      await client.query('CREATE TABLE pos_fresh.t (a int, b int, c int)')
      await client.query('CREATE SCHEMA pos_dropped')
      await client.query('CREATE TABLE pos_dropped.t (a int, obsolete int, b int, c int)')
      await client.query('ALTER TABLE pos_dropped.t DROP COLUMN obsolete')

      const read = async (schema: string, expression: string): Promise<unknown[]> => {
        const rows = await client.query(
          `SELECT ${expression} AS position
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE n.nspname = $1 AND c.relkind = 'r'
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attname`,
          [schema],
        )
        return rows.rows.map((r: { position: unknown }) => r.position)
      }

      // The premise: the two catalogs really do differ on the raw number.
      expect(await read('pos_fresh', 'a.attnum')).toEqual([1, 2, 3])
      expect(await read('pos_dropped', 'a.attnum')).toEqual([1, 3, 4])

      // The property: the expression this spec actually compares with does not.
      expect(await read('pos_dropped', POSITION_EXPRESSION)).toEqual(
        await read('pos_fresh', POSITION_EXPRESSION),
      )
    } finally {
      await client.query('DROP SCHEMA IF EXISTS pos_fresh CASCADE').catch(() => undefined)
      await client.query('DROP SCHEMA IF EXISTS pos_dropped CASCADE').catch(() => undefined)
    }
  })

  it('leaves no INVALID index behind', () => {
    // An interrupted `CREATE INDEX CONCURRENTLY` leaves a named-but-unusable index that
    // `IF NOT EXISTS` would skip forever. Part 2 sweeps those; this is the assertion
    // that the sweep is reached and that a clean apply needs no sweeping.
    expect(afterFirstApply.indexes.filter((r) => r['valid'] !== true)).toEqual([])
  })

  it('validates the job_sources CHECKs against real rows, not an empty table (SR-M-1)', async () => {
    // The rows inserted in `beforeAll` are still there, so the validating `ALTER TABLE
    // … ADD CONSTRAINT` above scanned them rather than nothing.
    const rows = await client.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE jsonb_typeof(config) = 'object')::int AS objects
         FROM job_sources`,
    )
    expect(rows.rows[0]).toEqual({ n: 3, objects: 3 })

    const validated = afterFirstApply.constraints.filter(
      (r) => r['table_name'] === 'job_sources' && r['kind'] === 'c',
    )
    expect(validated).toHaveLength(11)
    expect(validated.every((r) => r['validated'] === true)).toBe(true)
  })

  it('aborts part 1 on a job_sources row the config CHECK rejects, and the preflight finds it (SR-M-1)', async () => {
    // The reviewer's reproduction, pinned. `ck_job_sources_config_bounded` reads `config`
    // — a column this file does NOT add — so unlike the other ten it can fail on data
    // that already exists. It fails loudly and a rerun recovers, but an operator should
    // find out BEFORE the deploy, which is what the preflight query in part 1's header
    // is for. This test is what keeps that query honest.
    const guard = await pool.connect()
    try {
      await buildPreStoreStub(guard, CONFIG_GUARD_SCHEMA)
      await guard.query(`INSERT INTO job_sources (type, config) VALUES ('DOU_RSS', '[1,2]'::jsonb)`)

      // The preflight query, VERBATIM from part 1's header — not a `count(*)` variant of
      // it (CR-L-6). The point of this test is that the query an operator is told to run
      // finds the row that would abort the deploy, so it has to be that query.
      const preflight = await guard.query(
        `SELECT id, type, jsonb_typeof(config) AS kind, length(config::text) AS chars
           FROM job_sources
          WHERE jsonb_typeof(config) <> 'object' OR length(config::text) > 8192`,
      )
      expect(preflight.rowCount).toBe(1)
      expect(preflight.rows[0]['kind']).toBe('array')

      // The header's SECOND preflight (SR-L-7), also verbatim: on a database that has
      // not had any of the 18 columns hand-added, it must return nothing. Here the stub
      // is exactly that database, so zero rows is the expected answer — what this pins
      // is that the query runs and selects the right 18 names.
      const handAdded = await guard.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'job_sources'
            AND column_name IN ('manifest_id','namespace','manifest_version','policy_version',
                'config_version','account_meter_id','readiness','readiness_reason',
                'admin_state','admin_state_history','last_attempt_at','last_success_at',
                'last_nonempty_at','next_attempt_at','cooldown_until','consecutive_failures',
                'last_error_code','last_error_message')`,
      )
      expect(handAdded.rowCount).toBe(0)

      // Zero rows is cheap to achieve with the WRONG list, so the list itself is checked
      // against the reference: the names the header tells an operator to look for must be
      // exactly the columns this file adds to `job_sources`.
      // The parenthesised list, matched as a unit rather than by a fixed-length slice
      // (CR-L-10): a slice that is one edit too short silently drops names from the
      // comparison, and dropping names is the very thing being checked for.
      const headerList = /AND column_name IN \(([\s\S]*?)\);/.exec(readPart(PART_1))
      expect(
        headerList,
        "part 1's header must carry the hand-added-column preflight",
      ).not.toBeNull()
      const namesInHeader = [...headerList![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
      const namesAdded = reference.columns
        .filter((r) => r['table_name'] === 'job_sources')
        .map((r) => String(r['column_name']))
      expect(namesInHeader.sort()).toEqual(namesAdded.sort())

      // The assertion is on POSTGRES'S OWN message, not on the constraint name (CR-L-6).
      // `applyBothParts` echoes the failing statement into the error it throws, and that
      // statement is the `ADD CONSTRAINT "ck_job_sources_config_bounded" CHECK (…)` text
      // — so a regex on the name alone passes for ANY failure of that statement,
      // including one that has nothing to do with the data. `is violated by some row`
      // appears only in the server's error.
      await expect(applyBothParts(guard)).rejects.toThrow(
        /check constraint "ck_job_sources_config_bounded" of relation "job_sources" is violated by some row/,
      )
    } finally {
      await guard
        .query(`DROP SCHEMA IF EXISTS ${CONFIG_GUARD_SCHEMA} CASCADE`)
        .catch(() => undefined)
      guard.release()
    }
  }, 180_000)

  describe('the INVALID-index sweep (SR-M-2 / SR-M-3 / SR-M-4 / SR-M-5)', () => {
    // Nothing pinned the PROTECTIVE half of the sweep before this block: the suite had
    // no reference to `pg_stat_progress_create_index` at all, and the one
    // invalid-index test ran with nothing in flight — which the OLD, defective sweep
    // passed just as well. Deleting the guard clause left CI green.

    afterAll(async () => {
      // Leave the schema in the state the rest of the file expects.
      await client.query(`SET search_path TO ${SCHEMA}`)
      await applyIndexesOnly(client)
    })

    it('spares an index whose build is still running, and the build completes', async () => {
      await client.query(`DROP INDEX IF EXISTS ${PARKED_INDEX}`)
      const parked = await parkConcurrentBuild(pool, PARKED_INDEX)
      try {
        // The SWEEP alone, not the whole of part 2 — and the reason is a property worth
        // knowing: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` takes ShareUpdateExclusive
        // on the table BEFORE it notices the index already exists, and that lock
        // conflicts with itself. So while any build is in flight on one of these tables,
        // every remaining `CREATE INDEX CONCURRENTLY` in part 2 blocks and the file's own
        // `lock_timeout` fails the apply. Measured, not assumed. It is correct behaviour
        // (fail loud, re-run) and part 2's header now says so; it is simply not what this
        // test is about. The sweep itself takes no table lock.
        const { notices } = await withNotices(client, () => client.query(part2Blocks().sweep))

        expect(notices.join('\n')).toMatch(
          new RegExp(`index ${PARKED_INDEX} is invalid because a build is IN PROGRESS`),
        )
        const after = await readCatalog(client, SCHEMA)
        const row = after.indexes.find((r) => r['name'] === PARKED_INDEX)
        // Still there, still invalid — NOT dropped. Before the fix this was gone, and
        // the building session failed with `relation ... does not exist`.
        expect(row).toBeDefined()
        expect(row?.['valid']).toBe(false)
      } finally {
        await parked.release()
      }

      const settled = await readCatalog(client, SCHEMA)
      expect(settled.indexes.find((r) => r['name'] === PARKED_INDEX)?.['valid']).toBe(true)
    }, 180_000)

    it('sweeps nothing at all when it cannot attribute a build to a role (SR-M-4)', async () => {
      // `pg_stat_progress_create_index` does not hide a foreign session's ROW — it NULLs
      // `relid` / `index_relid` / `phase` for a build started by a role the reader is not
      // a member of. `NULL = oid` is NULL, so a naive `NOT EXISTS` comes back TRUE and
      // the guard evaporates exactly when it is needed. Measured here rather than argued:
      // the same session, after `SET ROLE` to a non-superuser, sees the row but not its
      // columns.
      //
      // This is not hypothetical maintenance work: the deploy connects as a superuser
      // today, and r5 Task 1.3c introduces least-privileged roles.
      await client.query(`DROP INDEX IF EXISTS ${PARKED_INDEX}`)
      const parked = await parkConcurrentBuild(pool, PARKED_INDEX)
      const probe = await pool.connect()
      try {
        await probe.query(`SET search_path TO ${SCHEMA}`)
        const masked = await probe.query(
          `SELECT count(*)::int AS total, count(relid)::int AS attributable
             FROM pg_stat_progress_create_index
            WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
        expect(masked.rows[0]).toEqual({ total: 1, attributable: 1 })

        await probe.query(`SET ROLE ${UNPRIVILEGED_ROLE}`)
        const maskedAsRole = await probe.query(
          `SELECT count(*)::int AS total, count(relid)::int AS attributable
             FROM pg_stat_progress_create_index
            WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
        // The row is visible; its target is not. This is the whole mechanism.
        expect(maskedAsRole.rows[0]).toEqual({ total: 1, attributable: 0 })

        const { notices } = await withNotices(probe, () => probe.query(part2Blocks().sweep))
        expect(notices.join('\n')).toMatch(/cannot prove no build is in progress/)
        expect(notices.join('\n')).not.toMatch(/dropping INVALID index/)

        await probe.query('RESET ROLE')
        const row = (await readCatalog(client, SCHEMA)).indexes.find(
          (r) => r['name'] === PARKED_INDEX,
        )
        expect(row).toBeDefined()
        expect(row?.['valid']).toBe(false)
      } finally {
        await probe.query('RESET ROLE').catch(() => undefined)
        probe.release()
        await parked.release()
      }
    }, 180_000)

    it('refuses to finish when an index is left invalid with nothing building it (SR-M-5)', async () => {
      // The sweep spares an invalid index while ANY build on its table is in flight,
      // including a build of a different index. `IF NOT EXISTS` then skips re-creating
      // it, so without the closing check part 2 exits 0 having left a named invalid
      // index — and six of the 44 are UNIQUE, so that is an unenforced store invariant.
      await client.query(`DROP INDEX IF EXISTS ${OTHER_INDEX_SAME_TABLE}`)
      await client.query(
        `UPDATE pg_index SET indisvalid = false
          WHERE indexrelid = format('%I.%I', $1::text, $2::text)::regclass`,
        [SCHEMA, PARKED_INDEX],
      )
      const parked = await parkConcurrentBuild(pool, OTHER_INDEX_SAME_TABLE)
      try {
        // Sweep then final check, for the lock reason explained in the test above.
        const { sweep, finalCheck } = part2Blocks()
        const { notices } = await withNotices(client, () => client.query(sweep))
        // The collateral spare is the premise of this test, not an accident.
        expect(notices.join('\n')).toMatch(
          new RegExp(`index ${PARKED_INDEX} is invalid because a build is IN PROGRESS`),
        )
        const stillInvalid = await readCatalog(client, SCHEMA)
        expect(stillInvalid.indexes.find((r) => r['name'] === PARKED_INDEX)?.['valid']).toBe(false)

        // …and this is what stops the file claiming success in that state.
        await expect(client.query(finalCheck)).rejects.toThrow(
          /index\(es\) of this store are INVALID with no build in progress/,
        )
      } finally {
        await parked.release()
      }

      // And re-running once nothing is in flight really is the repair.
      await applyIndexesOnly(client)
      const repaired = await readCatalog(client, SCHEMA)
      expect(repaired.indexes.filter((r) => r['valid'] !== true)).toEqual([])
    }, 180_000)
  })

  it('applies a second time without error and changes nothing', async () => {
    // What every deploy after the first one does: `deploy.yml` has no applied-migrations
    // registry, so both files run again on every single deploy, forever.
    await applyBothParts(client)
    expect(await readCatalog(client, SCHEMA)).toEqual(afterFirstApply)
  }, 180_000)

  it('rebuilds an INVALID index on the next apply, which is the documented repair', async () => {
    // The one failure mode of concurrent building, and the claim part 2's header makes
    // about it: re-running the file IS the repair, with no manual step.
    const target = 'uq_job_queue_generations_published_team'
    await client.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = format('%I.%I', $1::text, $2::text)::regclass`,
      [SCHEMA, target],
    )
    const broken = await readCatalog(client, SCHEMA)
    expect(broken.indexes.find((r) => r['name'] === target)?.['valid']).toBe(false)

    await applyBothParts(client)

    const repaired = await readCatalog(client, SCHEMA)
    expect(repaired.indexes.find((r) => r['name'] === target)?.['valid']).toBe(true)
    expect(repaired).toEqual(afterFirstApply)
  }, 180_000)

  /**
   * SR-M-4 — THE TWO DDL PATHS ARE PINNED AGAINST EACH OTHER.
   *
   * A schema change like this one ships twice: inside the fresh-create file, for a
   * database built from nothing, and as an ALTER file, for one already deployed. The
   * tests above compare only the FRESH path against the Drizzle reference, so until
   * this block existed a change made to one path and not the other was caught by
   * nothing at all — the defect class this whole file exists to prevent, aimed
   * squarely at the file itself.
   *
   * WHAT THIS PINS, stated narrowly so it is not read as more: the migration file
   * applied to a store that already carries the change is a NO-OP, and the catalog it
   * leaves still equals the Drizzle reference. So if the ALTER file's CHECK predicate,
   * column type or enum value drifts from the schema, re-applying it CHANGES something
   * here and these tests go red.
   *
   * WHAT IT DOES NOT PIN, deliberately: it does not reconstruct a genuinely
   * pre-change database, because that needs the SUPERSEDED revision of PART_1, which
   * lives in git history rather than on disk — and a spec that reads git history to
   * build its fixture is a spec that breaks on a squash. The honest limit is written
   * here instead of being papered over.
   */
  describe('the ALTER path agrees with the fresh path (SR-M-4)', () => {
    let beforeMigration: Catalog
    let withoutRedactionReasonNull: Catalog
    let afterMigration: Catalog
    let rolesCreatedHere: readonly string[] = []

    beforeAll(async () => {
      await buildPreStoreStub(client, MIGRATION_SCHEMA)
      await applyParts(client, [PART_1, PART_2, PART_5_MIGRATION])
      beforeMigration = await readCatalog(client, MIGRATION_SCHEMA)
      await applyParts(client, [PART_3_MIGRATION])
      // r5 Task 1.4b-iii — the ONE pre-change state this spec can rebuild without git
      // history: the store exactly as deployed before SR-M-5, i.e. without that CHECK.
      // Unlike the rest of this block, that makes the 1.4b-iii file's table half a REAL
      // upgrade here, not only a re-application to a store that already has it.
      await client.query(`ALTER TABLE job_queue_actions DROP CONSTRAINT ${REDACTION_REASON_NULL}`)
      withoutRedactionReasonNull = await readCatalog(client, MIGRATION_SCHEMA)
      // The 1.4b-iii file's own precondition: the roles its function half owns/grants to.
      rolesCreatedHere = await installDeployRoles(pool)
      await applyParts(client, [PART_4_MIGRATION])
      afterMigration = await readCatalog(client, MIGRATION_SCHEMA)
      // `buildPreStoreStub` repoints `search_path`; put it back, because the sibling
      // describes below share this connection and read the fresh schema through it.
      await client.query(`SET search_path TO ${SCHEMA}`)
    }, 180_000)

    afterAll(async () => {
      await dropRolesCreated(pool, rolesCreatedHere)
      const leaked = rolesCreatedHere.length > 0 ? await existingDeployRoles(pool) : []
      if (leaked.length > 0) {
        throw new Error(`teardown left role(s) behind in the cluster: ${leaked.join(', ')}`)
      }
    })

    it('1.4b-iii: the upgrade file ADDS the redaction-reason CHECK to a store that lacks it', () => {
      const names = (c: Catalog) => c.constraints.map((r) => r['name'])
      // The pre-change state really lacks it (so the comparison below is not two copies of
      // the fresh path), and the upgrade puts back exactly the reference's definition.
      expect(names(withoutRedactionReasonNull)).not.toContain(REDACTION_REASON_NULL)
      const expected = reference.constraints.filter((r) => r['name'] === REDACTION_REASON_NULL)
      expect(expected).toHaveLength(1)
      expect(afterMigration.constraints.filter((r) => r['name'] === REDACTION_REASON_NULL)).toEqual(
        expected,
      )
    })

    it('is idempotent on a store that already carries the change — nothing moves', () => {
      // Sizes first, so a comparison of two empty catalogs cannot pass quietly.
      expect(beforeMigration.constraints.length).toBeGreaterThan(0)
      expect(afterMigration).toEqual(beforeMigration)
    })

    it('leaves the enum and its VALUE ORDER equal to the Drizzle reference', () => {
      expect(afterMigration.enums).toEqual(reference.enums)
    })

    it('leaves every constraint definition equal to the Drizzle reference', () => {
      // Where a drifted CHECK predicate surfaces: `pg_get_constraintdef` is compared
      // in full, so one missing conjunct is a failure rather than a near-match.
      expect(afterMigration.constraints).toEqual(reference.constraints)
    })

    it('leaves every column equal to the reference, ignoring physical position only', () => {
      // Physical position legitimately differs between a fresh database and a migrated
      // one, permanently and in both directions: `CREATE TABLE` places a column where
      // it is declared, `ALTER TABLE ... ADD COLUMN` appends it. That difference is
      // expected rather than drift — the same reasoning this file already applies to
      // `job_sources` in `readCatalog` — so position is the one key dropped here, and
      // the only one. Everything else (type, nullability, default, identity,
      // generated, collation) is still compared.
      const withoutPosition = (rows: Catalog['columns']) =>
        rows.map(({ position: _position, ...rest }) => rest)
      expect(withoutPosition(afterMigration.columns)).toEqual(withoutPosition(reference.columns))
    })
  })
})
