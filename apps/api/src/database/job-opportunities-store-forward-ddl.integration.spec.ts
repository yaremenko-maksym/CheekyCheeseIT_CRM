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
 * What it compares
 * ----------------
 * Both sides are real databases, not metadata read twice:
 *   * `public` — built by `db:push` from the Drizzle schema (CI runs it before the
 *     integration suite; `assertRealDbSchema` below fails loudly if it did not);
 *   * an isolated schema — built by applying the two forward SQL files, statement by
 *     statement, exactly as `psql < file` would.
 * Then: enum types with their VALUE ORDER, columns with type / nullability / default,
 * constraints with their full definition (which is where FK actions and CHECK
 * expressions live), and indexes with their full definition (which is where
 * `DESC NULLS LAST`, a partial predicate and `NULLS NOT DISTINCT` live), plus
 * `indisvalid` so a half-built concurrent index is a failure and not a silent pass.
 *
 * The object list is PARSED OUT OF THE SQL FILES rather than hardcoded here. Two
 * reasons: a table added to the store is covered without touching this spec, and the
 * spec cannot quietly compare an empty set — the counts are asserted against the
 * numbers in the files' own headers.
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
const PART_1 = '2026-10-17_job_opportunities_store.sql'
const PART_2 = '2026-10-17_job_opportunities_store_indexes.sql'
const SCHEMA = 'ddl_job_opportunities_store'

/** What the two files' headers claim to create. A truncated file fails here first. */
const EXPECTED = {
  enums: 19,
  tables: 18,
  jobSourcesColumns: 18,
  indexes: 44,
} as const

const readPart = (name: string): string => readFileSync(join(MANUAL_DIR, name), 'utf8')

/** The object names the files themselves claim — never a list maintained by hand here. */
function parseDeclaredObjects(): {
  enums: string[]
  tables: string[]
  jobSourcesColumns: string[]
  constraints: string[]
  indexes: string[]
} {
  const part1 = readPart(PART_1)
  const part2 = readPart(PART_2)
  const all = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]!)
  const addColumnBlock = /ALTER TABLE job_sources\n([\s\S]*?);/.exec(part1)?.[1] ?? ''
  return {
    enums: all(/CREATE TYPE "([a-z_]+)" AS ENUM/g, part1),
    tables: all(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g, part1),
    jobSourcesColumns: all(/ADD COLUMN IF NOT EXISTS "([a-z_0-9]+)"/g, addColumnBlock),
    constraints: all(/ADD CONSTRAINT "([a-z_0-9]+)"/g, part1),
    indexes: all(/INDEX CONCURRENTLY IF NOT EXISTS "([a-z_0-9]+)"/g, part2),
  }
}

type CatalogRow = Record<string, unknown>
type Catalog = {
  enums: CatalogRow[]
  columns: CatalogRow[]
  constraints: CatalogRow[]
  indexes: CatalogRow[]
}

const declared = parseDeclaredObjects()

/**
 * `pg_get_constraintdef` / `pg_get_indexdef` schema-qualify a name that is not visible
 * in the reading session's `search_path`, so the same object renders differently
 * depending on which side it is read from. Erase the schema prefix on both sides and
 * what remains is comparable.
 */
const unqualify = (text: string, schema: string): string =>
  text.split(`"${schema}".`).join('').split(`${schema}.`).join('')

async function readCatalog(client: PoolClient, schema: string): Promise<Catalog> {
  const tables = declared.tables
  const enums = await client.query(
    `SELECT t.typname AS name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = ANY($2::text[])
      ORDER BY t.typname, e.enumsortorder`,
    [schema, declared.enums],
  )
  // `job_sources` is compared on the 18 columns this task adds and nothing else: the
  // rest of that table predates the store and is not this file's to reproduce.
  const columns = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (c.relname = ANY($2::text[])
             OR (c.relname = 'job_sources' AND a.attname = ANY($3::text[])))
      ORDER BY c.relname, a.attname`,
    [schema, tables, declared.jobSourcesColumns],
  )
  const constraints = await client.query(
    `SELECT c.relname AS table_name, con.conname AS name, con.contype AS kind,
            pg_get_constraintdef(con.oid) AS definition, con.convalidated AS validated
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND (c.relname = ANY($2::text[]) OR con.conname = ANY($3::text[]))
      ORDER BY c.relname, con.conname`,
    [schema, tables, declared.constraints],
  )
  const indexes = await client.query(
    `SELECT c.relname AS table_name, ic.relname AS name,
            pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND (c.relname = ANY($2::text[]) OR ic.relname = ANY($3::text[]))
      ORDER BY c.relname, ic.relname`,
    [schema, tables, declared.indexes],
  )
  const scrub = (rows: CatalogRow[], field: string): CatalogRow[] =>
    rows.map((r) => ({ ...r, [field]: unqualify(String(r[field]), schema) }))
  return {
    enums: enums.rows,
    columns: scrub(columns.rows, 'data_type'),
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

    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path TO ${SCHEMA}`)

    // "Production today": the objects the forward DDL depends on and does NOT create.
    // The two enums are copied out of `public` rather than spelled out, so this stub
    // cannot drift from the real catalogue and quietly weaken the comparison.
    for (const typeName of ['job_source_type', 'job_seniority']) {
      const labels = await client.query(
        `SELECT e.enumlabel FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = $1
          ORDER BY e.enumsortorder`,
        [typeName],
      )
      // A throw, not an `expect`: a failing setup must surface as a FAILED suite, and
      // `expect` outside a test block is not reported as one (and is a lint error).
      if (!labels.rowCount) {
        throw new Error(
          `[forward-ddl spec] public.${typeName} not found — the reference schema is ` +
            'unmigrated, so there is nothing to compare the forward DDL against.',
        )
      }
      const values = labels.rows.map((r: { enumlabel: string }) => `'${r.enumlabel}'`).join(', ')
      await client.query(`CREATE TYPE ${typeName} AS ENUM (${values})`)
    }
    await client.query(`CREATE TABLE users (id uuid PRIMARY KEY)`)
    await client.query(`CREATE TABLE teams (id uuid PRIMARY KEY)`)
    // Only the columns the new objects actually reference: `id` for the FKs pointing
    // here, `config` for `ck_job_sources_config_bounded`, `type` because the table is
    // meaningless without it.
    await client.query(
      `CREATE TABLE job_sources (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         type job_source_type NOT NULL,
         config jsonb NOT NULL DEFAULT '{}'::jsonb
       )`,
    )

    await applyBothParts(client)
    afterFirstApply = await readCatalog(client, SCHEMA)
  }, 180_000)

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    client?.release()
    await pool?.end()
  })

  it('creates every object its own header claims, and nothing is quietly empty', () => {
    expect(declared.enums).toHaveLength(EXPECTED.enums)
    expect(declared.tables).toHaveLength(EXPECTED.tables)
    expect(declared.jobSourcesColumns).toHaveLength(EXPECTED.jobSourcesColumns)
    expect(declared.indexes).toHaveLength(EXPECTED.indexes)

    // …and they are actually in the database, not merely in the file.
    expect(new Set(afterFirstApply.enums.map((r) => r['name']))).toEqual(new Set(declared.enums))
    expect(new Set(afterFirstApply.columns.map((r) => r['table_name']))).toEqual(
      new Set([...declared.tables, 'job_sources']),
    )
    const built = new Set(afterFirstApply.indexes.map((r) => r['name']))
    const missing = declared.indexes.filter((name) => !built.has(name))
    expect(missing, 'indexes the file creates but the database does not have').toEqual([])
  })

  it('enum types match db:push, value order included', () => {
    // Order, not membership: `ALTER TYPE … ADD VALUE BEFORE/AFTER` and a fresh
    // `CREATE TYPE` can agree on the set and disagree on `enumsortorder`, and the
    // order is what every `ORDER BY <enum column>` in the application sorts on.
    expect(afterFirstApply.enums).toEqual(reference.enums)
  })

  it('columns match db:push — type, nullability and default', () => {
    expect(afterFirstApply.columns).toEqual(reference.columns)
  })

  it('constraints match db:push — CHECK expressions, FK actions, validated state', () => {
    // `convalidated` is compared on purpose: `ADD CONSTRAINT … NOT VALID` is a tempting
    // way to make a CHECK cheap to add, and it leaves the constraint unenforced for
    // every row that already exists.
    expect(afterFirstApply.constraints).toEqual(reference.constraints)
  })

  it('indexes match db:push — partial predicates, NULLS NOT DISTINCT, sort order', () => {
    expect(afterFirstApply.indexes).toEqual(reference.indexes)
  })

  it('leaves no INVALID index behind', () => {
    // An interrupted `CREATE INDEX CONCURRENTLY` leaves a named-but-unusable index that
    // `IF NOT EXISTS` would skip forever. Part 2 sweeps those; this is the assertion
    // that the sweep is reached and that a clean apply needs no sweeping.
    expect(afterFirstApply.indexes.filter((r) => r['valid'] !== true)).toEqual([])
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
})
