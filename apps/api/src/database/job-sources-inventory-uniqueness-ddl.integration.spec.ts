import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * SR-M-4 (STAGED/DARK) — the staged forward DDL
 * `manual-staged/2026-11-02_job_sources_inventory_uniqueness.sql` against a REAL Postgres.
 *
 * AC 4 (forward DDL reproduces db:push): the file is applied TWICE into a scratch schema holding a
 * stub of `job_sources`, as the deploy would (one transaction each). The new objects it creates —
 * the `inventory_enabled` column, the partial unique index and the partial CHECK — equal what
 * `db:push` declares in `public`; the second apply changes nothing; it refuses to finish over a
 * same-named column of another type; and the backfill marks the ATS board types and nothing else.
 *
 * AC 5 (the invariant, on the db:push `public` table, inside BEGIN/ROLLBACK so nothing persists):
 *  - two inventory_enabled sources with the same `(type, namespace)` and DISTINCT configs are
 *    rejected by `uq_job_sources_inventory_type_namespace` (not the pre-existing type/config index);
 *  - two global `inventory_enabled = false` sources sharing `(type, '')` are ALLOWED;
 *  - an inventory_enabled source with `namespace = ''` is rejected by the CHECK.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-sources-inventory-uniqueness-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-02_job_sources_inventory_uniqueness.sql',
)
const SCHEMA = 'ddl_job_sources_inventory_uniqueness'
const TABLE = 'job_sources'
const INDEX = 'uq_job_sources_inventory_type_namespace'
const CHECK = 'ck_job_sources_inventory_namespace_nonempty'

let session: CrmAppSession
let client: PoolClient

const unqualify = (text: string, schema: string) => text.split(`${schema}.`).join('public.')

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

/** The three objects this file adds, read from one schema and schema-normalised for comparison. */
async function addedObjects(schema: string) {
  const { rows: column } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = 'inventory_enabled' AND NOT a.attisdropped`,
    [schema, TABLE],
  )
  const { rows: check } = await client.query(
    `SELECT k.conname AS name, k.convalidated AS validated, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.conname = $3`,
    [schema, TABLE, CHECK],
  )
  const { rows: index } = await client.query(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND i.relname = $3`,
    [schema, TABLE, INDEX],
  )
  return {
    column: column[0],
    check: check.map((r) => ({ ...r, def: unqualify(String(r['def']), schema) }))[0],
    index: index.map((r) => ({ ...r, def: unqualify(String(r['def']), schema) }))[0],
  }
}

/** Inserts one source into `public`; returns the violated constraint name, or null on success. */
async function insertSource(values: Record<string, string>): Promise<string | null> {
  const cols = Object.keys(values)
  await client.query('SAVEPOINT probe')
  try {
    await client.query(
      `INSERT INTO public.${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => values[c]).join(', ')})`,
    )
    await client.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT probe')
    return String((e as { constraint?: unknown }).constraint)
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'SR-M-4 staged DDL: inventory (type, namespace) uniqueness',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}, public`)
      // The stub carries exactly the columns the file touches; the enum resolves from `public`.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         type public.job_source_type NOT NULL,
         config jsonb NOT NULL DEFAULT '{}'::jsonb,
         namespace text NOT NULL DEFAULT '')`,
      )
      // One ATS row (backfilled true) and one global row (stays false).
      await client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (type, namespace) VALUES ('GREENHOUSE_ATS', 'greenhouse:acme')`,
      )
      await client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (type, namespace) VALUES ('JSEARCH_API', '')`,
      )
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

    it('AC 4: the column, partial index and partial CHECK equal what db:push declares', async () => {
      const ours = await addedObjects(SCHEMA)
      const pushed = await addedObjects('public')
      expect(ours.column).toMatchObject({
        name: 'inventory_enabled',
        type: 'boolean',
        not_null: true,
        default_expr: 'false',
      })
      // The index is UNIQUE and PARTIAL (the predicate is the whole point of the design).
      expect(String(ours.index.def)).toMatch(/CREATE UNIQUE INDEX .* WHERE inventory_enabled$/)
      expect(ours.check).toMatchObject({ validated: true })
      expect(String(ours.check.def)).toContain('length(namespace) > 0')
      // Equal to db:push, object for object.
      expect(ours.column).toEqual(pushed.column)
      expect(ours.index).toEqual(pushed.index)
      expect(ours.check).toEqual(pushed.check)
    })

    it('AC 4: the backfill marks exactly the ATS board types', async () => {
      const { rows } = await client.query(
        `SELECT type::text AS type, inventory_enabled FROM ${SCHEMA}.${TABLE} ORDER BY type`,
      )
      expect(rows).toEqual([
        { type: 'GREENHOUSE_ATS', inventory_enabled: true },
        { type: 'JSEARCH_API', inventory_enabled: false },
      ])
    })

    it('AC 4: the second apply succeeds and changes nothing', async () => {
      const before = await addedObjects(SCHEMA)
      await applyFile()
      expect(await addedObjects(SCHEMA)).toEqual(before)
    })

    it('AC 4: refuses to finish over a same-named NON-unique index, and a rebuild repairs it', async () => {
      // The `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op when the NAME already exists, so only the
      // closing check can see that the existing index is not the intended partial-unique one.
      await client.query(`DROP INDEX ${SCHEMA}.${INDEX}`)
      await client.query(
        `CREATE INDEX ${INDEX} ON ${SCHEMA}.${TABLE} USING btree (type, namespace) WHERE inventory_enabled`,
      )
      await expect(applyFile()).rejects.toThrow(
        /uq_job_sources_inventory_type_namespace is missing/,
      )
      await client.query(`DROP INDEX ${SCHEMA}.${INDEX}`)
      await applyFile()
      expect(await addedObjects(SCHEMA)).toEqual(await addedObjects('public'))
    })

    it('AC 5: two inventory_enabled sources with the same (type, namespace) are rejected by the partial index', async () => {
      await client.query('BEGIN')
      try {
        const row = (n: number) => ({
          type: `'GREENHOUSE_ATS'`,
          namespace: `'greenhouse:acme'`,
          inventory_enabled: 'true',
          config: `'{"n": ${n}}'::jsonb`, // distinct config, so the pre-existing (type, config) index cannot fire
        })
        expect(await insertSource(row(1))).toBeNull()
        expect(await insertSource(row(2))).toBe(INDEX)
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it("AC 5: two global inventory_enabled=false sources sharing (type, '') are allowed", async () => {
      await client.query('BEGIN')
      try {
        const row = (n: number) => ({
          type: `'JSEARCH_API'`,
          namespace: `''`,
          inventory_enabled: 'false',
          config: `'{"q": ${n}}'::jsonb`,
        })
        expect(await insertSource(row(1))).toBeNull()
        expect(await insertSource(row(2))).toBeNull()
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it('AC 5: an inventory_enabled source with an empty namespace is rejected by the CHECK', async () => {
      await client.query('BEGIN')
      try {
        expect(
          await insertSource({
            type: `'GREENHOUSE_ATS'`,
            namespace: `''`,
            inventory_enabled: 'true',
            config: `'{"n": 99}'::jsonb`,
          }),
        ).toBe(CHECK)
      } finally {
        await client.query('ROLLBACK')
      }
    })
  },
)
