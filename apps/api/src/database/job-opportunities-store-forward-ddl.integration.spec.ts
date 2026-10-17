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

const MANUAL_DIR = join(__dirname, '..', '..', 'drizzle', 'manual')
const SCHEMA_DIR = join(__dirname, 'schema')
const PART_1 = '2026-10-17_job_opportunities_store.sql'
const PART_2 = '2026-10-17_job_opportunities_store_indexes.sql'
const SCHEMA = 'ddl_job_opportunities_store'
const CONFIG_GUARD_SCHEMA = 'ddl_job_sources_config_guard'

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
  // `attnum` is compared only for the store's OWN tables, where both sides are built by
  // a single `CREATE TABLE`: on `job_sources` the reference gets the new columns inside
  // its `CREATE TABLE` while the candidate appends them with `ALTER TABLE`, so the
  // physical order legitimately differs there and carries no meaning either way.
  const columns = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr,
            a.attidentity AS identity,
            a.attgenerated AS generated,
            coalesce(co.collname, '') AS collation,
            CASE WHEN c.relname = 'job_sources' THEN NULL ELSE a.attnum END AS position
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

async function applyBothParts(client: PoolClient): Promise<void> {
  for (const part of [PART_1, PART_2]) {
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
  }, 180_000)

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    await client
      ?.query(`DROP SCHEMA IF EXISTS ${CONFIG_GUARD_SCHEMA} CASCADE`)
      .catch(() => undefined)
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
    expect(standaloneIndexes).toHaveLength(EXPECTED.indexes)
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

      // The preflight query, verbatim from part 1's header.
      const preflight = await guard.query(
        `SELECT count(*)::int AS n FROM job_sources
          WHERE jsonb_typeof(config) <> 'object' OR length(config::text) > 8192`,
      )
      expect(preflight.rows[0]['n']).toBe(1)

      await expect(applyBothParts(guard)).rejects.toThrow(/ck_job_sources_config_bounded/)
    } finally {
      await guard
        .query(`DROP SCHEMA IF EXISTS ${CONFIG_GUARD_SCHEMA} CASCADE`)
        .catch(() => undefined)
      guard.release()
    }
  }, 180_000)

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
})
