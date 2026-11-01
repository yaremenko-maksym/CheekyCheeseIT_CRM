import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { stagedGrantSql } from './privileges/generate-privilege-sql'
import { ROLES } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 4.6 S6b — the forward DDL (promoted from `manual-staged/` by Task 4.6 S6f)
 * `2026-10-31_job_bridge_deliveries.sql` against the `db:push` reference (ADR 2026-10-31 D-3). The
 * reference is `public` (pushed from the Drizzle schema); the candidate is a scratch schema holding
 * stubs of the three parent tables, into which the file is applied as the deploy would (one
 * transaction). `search_path` is `<scratch>, public` so the file resolves the existing
 * `job_source_type` enum from `public` and the parents from the stubs. Columns, constraints and
 * indexes must be equal; a second apply changes nothing; the closing check refuses a same-named
 * table without the constraints. The grants file requires the table to exist (it is promoted to
 * `drizzle/manual/` and no longer staged), so it gives `crm_app` the class-A privileges
 * unconditionally; the staged-grant mechanism is exercised only through `stagedGrantSql` below.
 */
const DRIZZLE = join(__dirname, '..', '..', 'drizzle')
const FILE = join(DRIZZLE, 'manual', '2026-10-31_job_bridge_deliveries.sql')
const SCHEMA = 'ddl_job_bridge_deliveries'
const TABLE = 'job_bridge_deliveries'
const PARENTS = ['job_sources', 'job_postings', 'job_collection_runs']
const CLASS_A = ['DELETE', 'INSERT', 'SELECT', 'UPDATE']

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

describe.skipIf(!hasDatabaseUrl())(
  'job_bridge_deliveries staged forward DDL (Task 4.6 S6b)',
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
      expect(ref.columns).toHaveLength(16)
      expect(ref.constraints).toHaveLength(12)
      expect(ref.indexes).toHaveLength(4)
      expect(candidate.columns).toEqual(ref.columns)
      expect(candidate.constraints).toEqual(ref.constraints)
      expect(candidate.indexes).toEqual(ref.indexes)
    })

    it('applies a second time without error and changes nothing', async () => {
      const before = await readCatalog(SCHEMA)
      await applyFile()
      expect(await readCatalog(SCHEMA)).toEqual(before)
    })

    it('the delivery identity is UNIQUE and the drain index is partial over PENDING', async () => {
      const { indexes } = await readCatalog(SCHEMA)
      const def = (name: string) => String(indexes.find((r) => r['name'] === name)?.['def'])
      expect(def('uq_job_bridge_delivery')).toMatch(
        /^CREATE UNIQUE INDEX .* \(consumer, identity_key, content_version\)$/,
      )
      expect(def('ix_job_bridge_pending')).toMatch(
        /\(source_id, consumer, created_at\) WHERE \(status = 'PENDING'::text\)$/,
      )
    })

    it('the foreign keys carry the ADR delete semantics', async () => {
      const { constraints } = await readCatalog(SCHEMA)
      const fk = (name: string) => String(constraints.find((r) => r['name'] === name)?.['def'])
      expect(fk('fk_job_bridge_deliveries_source')).toMatch(
        /REFERENCES job_sources\(id\) ON DELETE SET NULL$/,
      )
      expect(fk('fk_job_bridge_deliveries_posting')).toMatch(
        /REFERENCES job_postings\(id\) ON DELETE CASCADE$/,
      )
      expect(fk('fk_job_bridge_deliveries_enqueued_by_run')).toMatch(/ON DELETE RESTRICT$/)
      expect(fk('fk_job_bridge_deliveries_delivered_by_run')).toMatch(/ON DELETE RESTRICT$/)
    })

    it('the CHECKs refuse what the ADR forbids and admit a well-formed row', async () => {
      const run = '00000000-0000-4000-8000-000000000001'
      const posting = '00000000-0000-4000-8000-000000000002'
      await client.query('BEGIN')
      try {
        await client.query(`INSERT INTO ${SCHEMA}.job_collection_runs VALUES ($1)`, [run])
        await client.query(`INSERT INTO ${SCHEMA}.job_postings VALUES ($1)`, [posting])
        const base = {
          provider: `'DOU_RSS'`,
          consumer: `'LEGACY_POSTING'`,
          identity_key: `'fp-1'`,
          content_version: `'v1'`,
          payload: `'{}'::jsonb`,
          enqueued_by_run: `'${run}'`,
        }
        const done = { status: `'DONE'`, delivered_at: 'now()' }
        expect(await insertState(base)).toBeNull()
        // The delivery identity: a second row of the same (consumer, identity, version).
        expect(await insertState(base)).toBe('23505')
        const v = (n: number) => ({ ...base, content_version: `'v${n}'` })
        expect(await insertState({ ...v(2), provider: `'REMOTIVE_API'` })).toBe('23514')
        expect(await insertState({ ...v(3), consumer: `'OTHER'` })).toBe('23514')
        expect(await insertState({ ...v(4), status: `'LOST'` })).toBe('23514')
        // DONE without a stamp, and PENDING with one.
        expect(await insertState({ ...v(5), status: `'DONE'`, posting_id: `'${posting}'` })).toBe(
          '23514',
        )
        expect(await insertState({ ...v(6), delivered_at: 'now()' })).toBe('23514')
        // The DUPLICATE catch: a DONE posting delivery must name its posting.
        expect(await insertState({ ...v(7), ...done, outcome: `'DUPLICATE'` })).toBe('23514')
        expect(
          await insertState({
            ...v(8),
            ...done,
            outcome: `'DUPLICATE'`,
            posting_id: `'${posting}'`,
          }),
        ).toBeNull()
        // An INVALID posting delivery has no posting.
        expect(
          await insertState({ ...v(9), status: `'INVALID'`, delivered_at: 'now()' }),
        ).toBeNull()
        // A suggestion row always names its posting.
        expect(await insertState({ ...v(10), consumer: `'LEGACY_SUGGESTION'` })).toBe('23514')
        expect(
          await insertState({
            ...v(11),
            consumer: `'LEGACY_SUGGESTION'`,
            posting_id: `'${posting}'`,
          }),
        ).toBeNull()
        // The payload bound: 128 000 hex bytes exceed 64 KiB even if a datum were compressed 2:1.
        expect(
          await insertState({
            ...v(12),
            payload: `jsonb_build_object('x', (SELECT string_agg(md5(i::text), '') FROM generate_series(1, 4000) i))`,
          }),
        ).toBe('23514')
        // A purged posting takes its delivery rows with it (CASCADE), so it can be re-offered.
        await client.query(`DELETE FROM ${SCHEMA}.job_postings WHERE id = $1`, [posting])
        const left = await client.query(
          `SELECT count(*)::int AS n FROM ${SCHEMA}.${TABLE} WHERE posting_id IS NOT NULL`,
        )
        expect(left.rows[0].n).toBe(0)
        // A run with deliveries cannot be deleted (RESTRICT).
        expect(
          await (async () => {
            await client.query('SAVEPOINT run_delete')
            try {
              await client.query(`DELETE FROM ${SCHEMA}.job_collection_runs WHERE id = $1`, [run])
              return null
            } catch (e) {
              await client.query('ROLLBACK TO SAVEPOINT run_delete')
              return String((e as { code?: unknown }).code)
            }
          })(),
        ).toBe('23503')
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it('positive control: a dropped constraint makes the re-apply fail by name; a rebuild repairs it', async () => {
      await client.query(
        `ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ck_job_bridge_posting_done_has_posting`,
      )
      await expect(applyFile()).rejects.toThrow(/ck_job_bridge_posting_done_has_posting/)
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      await applyFile()
      expect(await readCatalog(SCHEMA)).toEqual(await readCatalog('public'))
    })

    it('positive control: a dropped index is a difference the comparison reports, and a re-apply repairs it', async () => {
      const ref = await readCatalog('public')
      await client.query(`DROP INDEX ${SCHEMA}.ix_job_bridge_pending`)
      expect((await readCatalog(SCHEMA)).indexes).not.toEqual(ref.indexes)
      await applyFile()
      expect((await readCatalog(SCHEMA)).indexes).toEqual(ref.indexes)
    })

    it('the same positive control covers the FK-child index this PR added', async () => {
      const ref = await readCatalog('public')
      await client.query(`DROP INDEX ${SCHEMA}.idx_job_bridge_deliveries_posting`)
      expect((await readCatalog(SCHEMA)).indexes).not.toEqual(ref.indexes)
      await applyFile()
      expect((await readCatalog(SCHEMA)).indexes).toEqual(ref.indexes)
    })

    it('the closing check names all three indexes, so none can be silently dropped from the guard', () => {
      // SPEC-L-1: `CREATE INDEX IF NOT EXISTS` recreates an absent index on every normal apply, so
      // the closing check's index branches (like the unique-index branch) are defence-in-depth —
      // they fire only over a same-named table whose columns block the CREATE. The guard still has
      // to NAME each index, or a later edit could drop the posting index and the check would miss
      // it. Asserted against the shipped file text rather than a contrived catalog.
      const guard = readFileSync(FILE, 'utf8')
      const block = guard.slice(guard.indexOf('DO $check$'))
      for (const name of [
        'uq_job_bridge_delivery',
        'ix_job_bridge_pending',
        'idx_job_bridge_deliveries_posting',
      ]) {
        expect(block).toContain(`'.${name}'`)
      }
    })

    it('refuses to finish over a same-named table that lacks the intended constraints', async () => {
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      // Every column, no constraint: each IF NOT EXISTS is a no-op and only the final check sees it.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (id uuid, source_id uuid, provider job_source_type,
         consumer text, identity_key text, content_version text, payload jsonb, status text,
         outcome text, posting_id uuid, suggestions_created integer, enqueued_by_run uuid,
         delivered_by_run uuid, attempts integer, created_at timestamptz, delivered_at timestamptz)`,
      )
      await expect(applyFile()).rejects.toThrow(/job_bridge_deliveries DDL: .* missing/)
      await client.query(`DROP TABLE ${SCHEMA}.${TABLE}`)
      await applyFile()
    })

    it('the shipped grants give crm_app exactly the class-A privileges on the table', async () => {
      expect(await heldPrivileges()).toEqual(CLASS_A)
    })

    it('the staged grant block is a no-op where its table does not exist', async () => {
      await expect(
        client.query(stagedGrantSql(['job_s6f_absent_relation'], ['SELECT'], ROLES.app)),
      ).resolves.toBeDefined()
    })
  },
)
