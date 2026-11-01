import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { stagedGrantSql } from './privileges/generate-privilege-sql'
import { ROLES, STAGED_RELATIONS } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 4.6 S8a — the forward DDL
 * `manual/2026-11-01_job_source_record_inventory_misses.sql` against the `db:push` reference
 * (ADR 2026-11-01 Decision 5). The reference is `public` (pushed from the Drizzle schema); the
 * candidate is a scratch schema holding a stub of the parent `job_source_records`, into which the
 * file is applied as the deploy would (one transaction). Columns, constraints and indexes must be
 * equal; a second apply changes nothing; the closing check refuses a same-named table without the
 * constraints. The table is in `drizzle/manual/` (deploy-wired), so the generated grants grant it
 * unconditionally; the staged-grant mechanism is exercised only through `stagedGrantSql` below.
 */
const DRIZZLE = join(__dirname, '..', '..', 'drizzle')
const FILE = join(DRIZZLE, 'manual', '2026-11-01_job_source_record_inventory_misses.sql')
const SCHEMA = 'ddl_job_inventory_misses'
const TABLE = 'job_source_record_inventory_misses'
const PARENTS = ['job_source_records']
const CLASS_A = ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
const REC = '00000000-0000-4000-8000-000000000001'
const RUN = '00000000-0000-4000-8000-0000000000aa'

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
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            row_number() OVER (ORDER BY a.attnum) AS position
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, TABLE],
  )
  const constraints = await client.query(
    `SELECT k.conname AS name, k.contype AS kind, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY k.conname`,
    [schema, TABLE],
  )
  const indexes = await client.query(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY i.relname`,
    [schema, TABLE],
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

async function heldPrivileges(): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      WHERE has_table_privilege($1, 'public.' || $2, p) ORDER BY p`,
    [ROLES.app, TABLE],
  )
  return rows.map((r) => String(r['p']))
}

/** Inserts one delivery row into the candidate schema; returns the SQLSTATE of a refusal. */
async function insertState(values: Record<string, string>): Promise<string | null> {
  const cols = Object.keys(values)
  await client.query('SAVEPOINT probe')
  try {
    await client.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => values[c]).join(', ')})`,
    )
    await client.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT probe')
    return String((e as { code?: unknown }).code)
  }
}

const base = {
  source_record_id: `'${REC}'`,
  board: `'greenhouse:acme'`,
  config_version: '1',
  first_miss_run_id: `'${RUN}'`,
  first_miss_at: `'2026-10-30T09:00:00Z'`,
  last_miss_run_id: `'${RUN}'`,
  last_miss_at: `'2026-10-31T09:00:00Z'`,
  last_inventory_size: '100',
}

describe.skipIf(!hasDatabaseUrl())(
  'job_source_record_inventory_misses staged forward DDL (Task 4.6 S8a)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}, public`)
      for (const parent of PARENTS)
        await client.query(`CREATE TABLE ${parent} (id uuid PRIMARY KEY)`)
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

    it('creates exactly the db:push catalog — columns, constraints, indexes', async () => {
      const ref = await readCatalog('public')
      const candidate = await readCatalog(SCHEMA)
      expect(ref.columns).toHaveLength(10)
      expect(ref.constraints).toHaveLength(7)
      expect(ref.indexes).toHaveLength(1)
      expect(candidate.columns).toEqual(ref.columns)
      expect(candidate.constraints).toEqual(ref.constraints)
      expect(candidate.indexes).toEqual(ref.indexes)
    })

    it('applies a second time without error and changes nothing', async () => {
      const before = await readCatalog(SCHEMA)
      await applyFile()
      expect(await readCatalog(SCHEMA)).toEqual(before)
    })

    it('the key is (record, board, config version) and the record FK cascades', async () => {
      const { constraints } = await readCatalog(SCHEMA)
      const def = (name: string) => String(constraints.find((r) => r['name'] === name)?.['def'])
      expect(def('job_source_record_inventory_misses_pkey')).toBe(
        'PRIMARY KEY (source_record_id, board, config_version)',
      )
      expect(def('fk_job_source_record_inventory_misses_record')).toMatch(
        /REFERENCES job_source_records\(id\) ON DELETE CASCADE$/,
      )
    })

    it('the CHECKs refuse what the ADR forbids, admit a well-formed row, and the FK cascades', async () => {
      await client.query('BEGIN')
      try {
        await client.query(`INSERT INTO ${SCHEMA}.job_source_records VALUES ($1)`, [REC])
        expect(await insertState(base)).toBeNull()
        // The key: the same (record, board, version) twice; another version is a new chain.
        expect(await insertState(base)).toBe('23505')
        expect(await insertState({ ...base, config_version: '2' })).toBeNull()
        const v = (n: number) => ({ ...base, config_version: String(10 + n) })
        expect(await insertState({ ...v(1), consecutive_misses: '-1' })).toBe('23514')
        expect(await insertState({ ...v(2), config_version: '0' })).toBe('23514')
        expect(await insertState({ ...v(3), last_inventory_size: '-1' })).toBe('23514')
        expect(await insertState({ ...v(4), board: `'   '` })).toBe('23514')
        expect(await insertState({ ...v(5), board: `repeat('b', 201)` })).toBe('23514')
        expect(await insertState({ ...v(6), last_miss_at: `'2026-10-29T09:00:00Z'` })).toBe('23514')
        // An unknown record is refused.
        expect(
          await insertState({
            ...v(7),
            source_record_id: `'00000000-0000-4000-8000-0000000000ff'`,
          }),
        ).toBe('23503')
        // A purged record takes its counter rows with it.
        await client.query(`DELETE FROM ${SCHEMA}.job_source_records WHERE id = $1`, [REC])
        const left = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.${TABLE}`)
        expect(left.rows[0].n).toBe(0)
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it('positive control: a dropped constraint makes the re-apply fail by name; a rebuild repairs it', async () => {
      await client.query(
        `ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ck_job_inventory_misses_span`,
      )
      await expect(applyFile()).rejects.toThrow(/ck_job_inventory_misses_span/)
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      await applyFile()
      expect(await readCatalog(SCHEMA)).toEqual(await readCatalog('public'))
    })

    it('positive control: a dropped FK makes the re-apply fail by name', async () => {
      await client.query(
        `ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT fk_job_source_record_inventory_misses_record`,
      )
      await expect(applyFile()).rejects.toThrow(/fk_job_source_record_inventory_misses_record/)
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      await applyFile()
    })

    it('refuses to finish over a same-named table that lacks the intended constraints', async () => {
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      // Every column, no constraint: the IF NOT EXISTS is a no-op and only the final check sees it.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (source_record_id uuid, board text, config_version integer,
         consecutive_misses integer, first_miss_run_id uuid, first_miss_at timestamptz,
         last_miss_run_id uuid, last_miss_at timestamptz, last_inventory_size integer,
         updated_at timestamptz)`,
      )
      await expect(applyFile()).rejects.toThrow(
        /job_source_record_inventory_misses DDL: .* missing/,
      )
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      await applyFile()
    })

    it('the table is promoted (no longer staged) and the shipped grants give crm_app exactly the class-A privileges', async () => {
      expect(STAGED_RELATIONS[TABLE]).toBeUndefined()
      // `public` holds the db:push table; the shipped grants ran in this database.
      expect(await heldPrivileges()).toEqual(CLASS_A)
    })

    it('the staged grant block is a no-op where its table does not exist', async () => {
      // Generator-path smoke check: nothing shipped is staged for this table any more.
      await expect(
        client.query(stagedGrantSql(['job_s8a_absent_relation'], ['SELECT'], ROLES.app)),
      ).resolves.toBeDefined()
    })
  },
)
