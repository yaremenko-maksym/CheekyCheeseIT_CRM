import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { stagedGrantSql } from './privileges/generate-privilege-sql'
import { ROLES, STAGED_RELATIONS } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 4.5 AC 11 — the staged forward DDL `2026-10-25_job_record_store.sql` against the
 * `db:push` reference. The reference is `public` (pushed from the Drizzle schema); the candidate
 * is a scratch schema holding stubs of the four parent tables, into which the file is applied as
 * the deploy would (`--single-transaction`). The two tables' columns, constraints and indexes
 * must be equal; a second apply changes nothing; the shipped grants file gives `crm_app` the
 * class-A privileges on them, and its staged block is harmless where a table is absent.
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-10-25_job_record_store.sql',
)
const SCHEMA = 'ddl_job_record_store'
const TABLES = ['job_opportunity_identity_tokens', 'job_run_records', 'job_source_record_heads']
const PARENTS = [
  'job_collection_runs',
  'job_source_records',
  'job_source_record_revisions',
  'job_opportunities',
  'users',
]

type Row = Record<string, unknown>
type Catalog = { columns: Row[]; constraints: Row[]; indexes: Row[] }

let session: CrmAppSession
let client: PoolClient

const unqualify = (text: string, schema: string) =>
  text.split(`"${schema}".`).join('').split(`${schema}.`).join('')

async function readCatalog(schema: string): Promise<Catalog> {
  const clean = (rows: Row[], field: string) =>
    rows.map((r) => ({ ...r, [field]: unqualify(String(r[field]), schema) }))
  const columns = await client.query(
    `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum) AS position
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema, TABLES],
  )
  const constraints = await client.query(
    `SELECT c.relname AS table, k.conname AS name, k.contype AS kind, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
      ORDER BY c.relname, k.conname`,
    [schema, TABLES],
  )
  const indexes = await client.query(
    `SELECT t.relname AS table, i.relname AS name, pg_get_indexdef(i.oid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = ANY($2::text[])
      ORDER BY t.relname, i.relname`,
    [schema, TABLES],
  )
  return {
    columns: columns.rows.map((r) => ({ ...r, default_expr: r['default_expr'] ?? null })),
    constraints: clean(constraints.rows, 'def'),
    indexes: clean(indexes.rows, 'def'),
  }
}

async function applyFile(): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(FILE, 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

describe.skipIf(!hasDatabaseUrl())('job record store forward DDL (Task 4.5 AC 11)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}`)
    for (const parent of PARENTS) await client.query(`CREATE TABLE ${parent} (id uuid PRIMARY KEY)`)
    await applyFile()
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`SET search_path = public`)
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      client?.release()
    } finally {
      await session.close()
    }
  })

  it('creates exactly the db:push catalog of both tables — columns, constraints, indexes', async () => {
    const ref = await readCatalog('public')
    const candidate = await readCatalog(SCHEMA)
    expect(ref.columns).toHaveLength(18)
    expect(ref.constraints.length).toBeGreaterThanOrEqual(10)
    expect(ref.indexes.length).toBe(10)
    expect(candidate.columns).toEqual(ref.columns)
    expect(candidate.constraints).toEqual(ref.constraints)
    expect(candidate.indexes).toEqual(ref.indexes)
  })

  it('applies a second time without error and changes nothing', async () => {
    const before = await readCatalog(SCHEMA)
    await applyFile()
    expect(await readCatalog(SCHEMA)).toEqual(before)
  })

  it('the active-token index is partial: a released token frees its key for a new claim', async () => {
    const ref = await readCatalog('public')
    const def = ref.indexes.find(
      (r) => r['name'] === 'uq_job_opportunity_identity_tokens_active_key',
    )
    expect(String(def?.['def'])).toMatch(/UNIQUE INDEX .* WHERE \(released_at IS NULL\)/)
  })

  it('positive control: a dropped index is a difference the comparison reports, and a re-apply repairs it', async () => {
    const ref = await readCatalog('public')
    await client.query(`DROP INDEX ${SCHEMA}.idx_job_run_records_revision`)
    expect((await readCatalog(SCHEMA)).indexes).not.toEqual(ref.indexes)
    await applyFile()
    expect((await readCatalog(SCHEMA)).indexes).toEqual(ref.indexes)
  })

  it('refuses to finish over a same-named table that lacks the intended constraints', async () => {
    await client.query(`DROP TABLE ${SCHEMA}.job_run_records`)
    // Every column, no constraint: each IF NOT EXISTS is a no-op and only the final check sees it.
    await client.query(
      `CREATE TABLE ${SCHEMA}.job_run_records (run_id uuid, source_record_id uuid, revision_id uuid, observed_at timestamptz)`,
    )
    await expect(applyFile()).rejects.toThrow(/fk_job_run_records_run|pk_job_run_records/)
    await client.query(`DROP TABLE ${SCHEMA}.job_run_records`)
    await applyFile()
  })

  it('the shipped grants give crm_app the class-A privileges on both tables', async () => {
    const { rows } = await client.query(
      `SELECT t AS table, p AS privilege, has_table_privilege($1, 'public.' || t, p) AS held
         FROM unnest($2::text[]) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
        ORDER BY t, p`,
      [ROLES.app, Object.keys(STAGED_RELATIONS)],
    )
    expect(rows.filter((r) => r['held'] !== (r['privilege'] !== 'TRUNCATE'))).toEqual([])
    expect(rows).toHaveLength(15)
  })

  it('the staged grant block is a no-op where its table does not exist', async () => {
    await expect(
      client.query(stagedGrantSql(['job_t45_absent_relation'], ['SELECT'], ROLES.app)),
    ).resolves.toBeDefined()
  })
})
