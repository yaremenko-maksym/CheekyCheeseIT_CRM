import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * CR-M-4 (STAGED/DARK) — the staged forward DDL
 * `manual/2026-11-02_job_dirty_work_pending_partial.sql` against a REAL Postgres.
 *
 * The file adds ONE object: `idx_job_dirty_work_pending_generic`, a PARTIAL btree index on
 * `(status, created_at)` WHERE `reason <> 'DETAIL_FETCH'` — the generic-pending claim scan with the
 * detail backlog excluded (so a generic claimer skips it after the ON_DEMAND flip).
 *
 * It is built with `CREATE INDEX CONCURRENTLY`, which CANNOT run inside a transaction block, so —
 * unlike the transactional staged files — this file is applied as a SINGLE AUTOCOMMIT query, never
 * wrapped in BEGIN/COMMIT. The deploy wiring runs it the same way.
 *
 * AC (forward DDL reproduces db:push): the file is applied into a scratch schema holding a stub of
 * `job_dirty_work`; the index it creates equals — object for object, schema-normalised — what
 * `db:push` declares for the same index in `public`. A second apply changes nothing (IF NOT
 * EXISTS). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-dirty-work-pending-partial-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-02_job_dirty_work_pending_partial.sql',
)
const SCHEMA = 'ddl_job_dirty_work_pending_partial'
const TABLE = 'job_dirty_work'
const INDEX = 'idx_job_dirty_work_pending_generic'

let session: CrmAppSession
let client: PoolClient

const unqualify = (text: string, schema: string) => text.split(`${schema}.`).join('public.')

/**
 * Applies the file as a SINGLE autocommit query — no BEGIN/COMMIT: `CREATE INDEX CONCURRENTLY`
 * aborts inside a transaction block. The search_path (set in beforeAll) routes the unqualified
 * `job_dirty_work` to the scratch schema.
 */
async function applyFile(): Promise<void> {
  await client.query(readFileSync(FILE, 'utf8'))
}

/** The one index this file adds, read from one schema and schema-normalised for comparison. */
async function addedIndex(schema: string) {
  const { rows } = await client.query(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND i.relname = $3`,
    [schema, TABLE, INDEX],
  )
  return rows.map((r) => ({ ...r, def: unqualify(String(r['def']), schema) }))[0]
}

describe.skipIf(!hasDatabaseUrl())(
  'CR-M-4 staged DDL: generic-pending partial index excluding DETAIL_FETCH',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}, public`)
      // The stub carries exactly the columns the index touches; the status enum resolves from `public`.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         status public.job_dirty_work_status NOT NULL DEFAULT 'PENDING',
         reason text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now())`,
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

    it('applies cleanly and the index is PARTIAL on (status, created_at) WHERE reason <> DETAIL_FETCH', async () => {
      const ours = await addedIndex(SCHEMA)
      expect(ours).toBeDefined()
      expect(String(ours.def)).toMatch(/USING btree \(status, created_at\)/)
      // The design: the partial predicate that omits the detail backlog.
      expect(String(ours.def)).toMatch(/WHERE \(reason <> 'DETAIL_FETCH'::text\)/)
      expect(String(ours.def)).not.toMatch(/UNIQUE/)
    })

    it('equals what db:push declares for the same index in public', async () => {
      expect(await addedIndex(SCHEMA)).toEqual(await addedIndex('public'))
    })

    it('a second apply changes nothing (IF NOT EXISTS)', async () => {
      const before = await addedIndex(SCHEMA)
      await applyFile()
      expect(await addedIndex(SCHEMA)).toEqual(before)
    })
  },
)
