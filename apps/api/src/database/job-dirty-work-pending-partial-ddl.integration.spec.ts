import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parkConcurrentBuild, withNotices } from './__test-helpers__/concurrent-index-build'
import {
  type CrmAppSession,
  openCrmAppSession,
  resolveConnectionPlan,
} from './__test-helpers__/crm-app-session'
import { splitSqlStatements } from './manual-sql-statements'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * CR-M-4 (promoted by backlog 434) — the forward DDL
 * `manual/2026-11-02_job_dirty_work_pending_partial.sql` against a REAL Postgres.
 *
 * The file adds ONE object: `idx_job_dirty_work_pending_generic`, a PARTIAL btree index on
 * `(status, created_at)` WHERE `reason <> 'DETAIL_FETCH'` — the generic-pending claim scan with the
 * detail backlog excluded (so a generic claimer skips it after the ON_DEMAND flip).
 *
 * It is built with `CREATE INDEX CONCURRENTLY`, which CANNOT run inside a transaction block, so —
 * unlike the transactional files — this file is applied statement by statement in AUTOCOMMIT, never
 * wrapped in BEGIN/COMMIT. The deploy wiring runs it the same way (`psql < file`).
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
const DIRTY_WORK_PARK = { schema: SCHEMA, searchPath: `${SCHEMA}, public`, table: TABLE }

let session: CrmAppSession
let client: PoolClient
let pool: Pool

const unqualify = (text: string, schema: string) => text.split(`${schema}.`).join('public.')

/**
 * Applies the file statement by statement in autocommit, the way `psql < file` does: no
 * BEGIN/COMMIT, because `CREATE INDEX CONCURRENTLY` aborts inside a transaction block (and a
 * multi-statement simple query is an implicit one). The search_path (set in beforeAll) routes
 * the unqualified `job_dirty_work` to the scratch schema.
 */
async function applyFile(): Promise<void> {
  for (const statement of splitSqlStatements(readFileSync(FILE, 'utf8')))
    await client.query(statement)
}

/** The file's two `DO` blocks: the INVALID-leftover sweep and the closing check (CR-M-1). */
function doBlocks(): { sweep: string; finalCheck: string } {
  const blocks = readFileSync(FILE, 'utf8').match(/DO \$\$\nDECLARE[\s\S]*?\nEND \$\$;/g)
  if (blocks?.length !== 2) throw new Error(`expected 2 DO blocks, found ${blocks?.length ?? 0}`)
  return { sweep: blocks[0]!, finalCheck: blocks[1]! }
}

/** Marks the index INVALID — the state an interrupted CONCURRENTLY build leaves behind. */
async function invalidate(): Promise<void> {
  await client.query(
    `UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = format('%I.%I', $1::text, $2::text)::regclass`,
    [SCHEMA, INDEX],
  )
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

async function isValid(): Promise<boolean | undefined> {
  const { rows } = await client.query(
    `SELECT x.indisvalid AS valid
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = $1 AND i.relname = $2`,
    [SCHEMA, INDEX],
  )
  return rows[0]?.['valid']
}

describe.skipIf(!hasDatabaseUrl())(
  'CR-M-4 forward DDL: generic-pending partial index excluding DETAIL_FETCH',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
      // CR-M-2: the builder pool is the SWEEPER's role (`session.admin`'s URL), so the parked build
      // is visible to the sweep and a pass means the in-progress check spared it.
      pool = new Pool({ connectionString: resolveConnectionPlan(process.env).ownerUrl })
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
        await pool?.end()
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

    it('the next apply sweeps an INVALID leftover and rebuilds it (CR-M-1)', async () => {
      const before = await addedIndex(SCHEMA)
      await invalidate()
      expect(await isValid()).toBe(false)
      // Without the sweep, `IF NOT EXISTS` sees the name, skips, and the file exits 0.
      await applyFile()
      expect(await isValid()).toBe(true)
      expect(await addedIndex(SCHEMA)).toEqual(before)
    })

    it('spares an index whose build is still running, and the build completes (LOW)', async () => {
      await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${INDEX}`)
      const parked = await parkConcurrentBuild(pool, { ...DIRTY_WORK_PARK, indexName: INDEX })
      try {
        const { sweep } = doBlocks()
        // The sweep's own bound, as the file sets it: a sweep that wrongly DROPs the in-flight
        // index fails in 10 s instead of queueing behind the build it is blocking.
        await client.query(`SET lock_timeout = '10s'`)
        const { notices } = await withNotices(client, () => client.query(sweep))
        // CR-M-2: the sweep SAW the build (no masked-progress early return), so sparing it is the
        // in-progress check's doing, not an invisible build's.
        expect(notices.join('\n')).not.toMatch(/NOTHING is swept/)
        expect(notices.join('\n')).not.toMatch(/dropping INVALID index/)
        expect(await isValid()).toBe(false)
      } finally {
        await parked.release()
      }
      expect(await isValid()).toBe(true)
    }, 180_000)

    it('the closing check refuses an INVALID or a missing index (CR-M-1)', async () => {
      const { finalCheck } = doBlocks()
      await client.query(finalCheck)
      await invalidate()
      await expect(client.query(finalCheck)).rejects.toThrow(
        /idx_job_dirty_work_pending_generic is INVALID/,
      )
      await client.query(`DROP INDEX ${SCHEMA}.${INDEX}`)
      await expect(client.query(finalCheck)).rejects.toThrow(
        /idx_job_dirty_work_pending_generic is MISSING/,
      )
      await applyFile()
      expect(await isValid()).toBe(true)
    })

    it('a transaction open longer than the sweep lock_timeout does not fail the build (CR-M-1 of PR #1333)', async () => {
      // Real timeouts, not scaled-down ones: the snapshot is held 12 s, past the sweep's 10 s
      // lock_timeout and well inside the CIC's 5 min one. Under one session-wide 10 s timeout the
      // CIC's wait for this older snapshot is cancelled and the apply fails.
      const holder = await pool.connect()
      try {
        await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${INDEX}`)
        await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await holder.query(`SELECT count(*) FROM ${SCHEMA}.${TABLE}`)
        const applying = applyFile().then(
          () => undefined,
          (error: Error) => error,
        )
        await new Promise((resolve) => setTimeout(resolve, 12_000))
        await holder.query('COMMIT')
        expect(await applying).toBeUndefined()
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(await isValid()).toBe(true)
    }, 60_000)
  },
)
