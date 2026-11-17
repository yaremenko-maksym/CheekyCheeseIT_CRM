import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect } from 'drizzle-orm/pg-core'
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
import { type ClaimConsumer, dirtyWorkStatements } from '../job-sourcing/ownership/dirty-work.store'

/**
 * Backlog 347 (1) (promoted by backlog 434) — the forward DDL
 * `manual/2026-11-03_job_dirty_work_partition_partial.sql` against a REAL Postgres.
 *
 * The file adds TWO partial btree indexes on `job_dirty_work (status, created_at)`, one per
 * `claimDirtyBatch` reason partition: `idx_job_dirty_work_pending_match` and
 * `idx_job_dirty_work_pending_availability`.
 *
 * Both are `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block — and a
 * multi-statement simple query IS one — so the file is applied statement by statement in
 * autocommit (as psql without -1 does), never as one query.
 *
 * AC: (a) the indexes the file creates equal, schema-normalised, what `db:push` declares in
 * `public`; (b) a second apply changes nothing; (c) the planner can use each index for the REAL
 * claim SQL of its consumer in a GENERIC plan (the predicate is implied by the query's literal
 * conjuncts, not by parameter values), and the match claim cannot use the availability index.
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-dirty-work-partition-partial-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-03_job_dirty_work_partition_partial.sql',
)
const SCHEMA = 'ddl_job_dirty_work_partition_partial'
const TABLE = 'job_dirty_work'
const INDEX: Record<ClaimConsumer, string> = {
  MATCH: 'idx_job_dirty_work_pending_match',
  AVAILABILITY: 'idx_job_dirty_work_pending_availability',
}
const INDEXES = Object.values(INDEX)
const DIRTY_WORK_PARK = { schema: SCHEMA, searchPath: `${SCHEMA}, public`, table: TABLE }

let session: CrmAppSession
let client: PoolClient
let pool: Pool

const unqualify = (text: string, schema: string) => text.split(`${schema}.`).join('public.')

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

/** Marks an index INVALID — the state an interrupted CONCURRENTLY build leaves behind. */
async function invalidate(index: string): Promise<void> {
  await client.query(
    `UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = format('%I.%I', $1::text, $2::text)::regclass`,
    [SCHEMA, index],
  )
}

/** The indexes this file adds, read from one schema and schema-normalised for comparison. */
async function addedIndexes(schema: string) {
  const { rows } = await client.query(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def, x.indisvalid AS valid
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND i.relname = ANY($3)
      ORDER BY i.relname`,
    [schema, TABLE, INDEXES],
  )
  return rows.map((r) => ({ ...r, def: unqualify(String(r['def']), schema) }))
}

/** The index names a GENERIC plan of the real claim SQL for `consumer` scans. */
async function claimPlanIndexes(consumer: ClaimConsumer): Promise<string[]> {
  const q = new PgDialect().sqlToQuery(
    dirtyWorkStatements.claim('w', 200, 300_000, ['OPPORTUNITY'], consumer),
  )
  // The partition conjuncts must be literals: only kind, batch, owner, lease are parameters.
  expect(q.params).toEqual(['OPPORTUNITY', 200, 'w', 300_000])
  const name = `claim_${consumer.toLowerCase()}`
  await client.query(`DEALLOCATE ALL`)
  await client.query(`PREPARE ${name} AS ${q.sql}`)
  const { rows } = await client.query(
    `EXPLAIN (FORMAT JSON) EXECUTE ${name}('OPPORTUNITY', 200, 'w', 300000)`,
  )
  const names: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Index Name' && typeof v === 'string') names.push(v)
      else walk(v)
    }
  }
  walk(rows[0]['QUERY PLAN'])
  return names
}

describe.skipIf(!hasDatabaseUrl())(
  'backlog 347 forward DDL: reason-partition partial indexes on job_dirty_work',
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
      // Columns copied from the db:push table (no indexes), so the claim SQL resolves unchanged.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (LIKE public.${TABLE} INCLUDING DEFAULTS)`,
      )
      await applyFile()
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
        await client?.query(`DEALLOCATE ALL`)
        await client?.query(`RESET plan_cache_mode`)
        await client?.query(`RESET enable_seqscan`)
        await client?.query(`SET search_path = public`)
        await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        client?.release()
        await pool?.end()
      } finally {
        await session.close()
      }
    })

    it('applies cleanly: two valid, non-unique PARTIAL btree indexes on (status, created_at)', async () => {
      const ours = await addedIndexes(SCHEMA)
      expect(ours.map((r) => r.name)).toEqual([INDEX.AVAILABILITY, INDEX.MATCH])
      for (const r of ours) {
        expect(r.valid).toBe(true)
        expect(String(r.def)).toMatch(/USING btree \(status, created_at\) WHERE /)
        expect(String(r.def)).not.toMatch(/UNIQUE/)
        expect(String(r.def)).toContain("starts_with(reason, 'AVAILABILITY:'::text)")
      }
      // MATCH is the complement (the NOT form); AVAILABILITY is the positive partition.
      expect(String(ours[1]!.def)).toMatch(/NOT /)
      expect(String(ours[0]!.def)).not.toMatch(/NOT /)
    })

    it('equals what db:push declares for the same indexes in public', async () => {
      expect(await addedIndexes(SCHEMA)).toEqual(await addedIndexes('public'))
    })

    it('a second apply changes nothing (IF NOT EXISTS)', async () => {
      const before = await addedIndexes(SCHEMA)
      await applyFile()
      expect(await addedIndexes(SCHEMA)).toEqual(before)
    })

    it('the next apply sweeps an INVALID leftover and rebuilds it (CR-M-1)', async () => {
      const before = await addedIndexes(SCHEMA)
      await invalidate(INDEX.MATCH)
      const broken = await addedIndexes(SCHEMA)
      expect(broken.find((r) => r.name === INDEX.MATCH)?.valid).toBe(false)
      // Without the sweep, `IF NOT EXISTS` sees the name, skips, and the file exits 0.
      await applyFile()
      expect(await addedIndexes(SCHEMA)).toEqual(before)
    })

    it('spares an index whose build is still running, and the build completes (LOW)', async () => {
      await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${INDEX.MATCH}`)
      const parked = await parkConcurrentBuild(pool, { ...DIRTY_WORK_PARK, indexName: INDEX.MATCH })
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
        const broken = await addedIndexes(SCHEMA)
        expect(broken.find((r) => r.name === INDEX.MATCH)?.valid).toBe(false)
      } finally {
        await parked.release()
      }
      const settled = await addedIndexes(SCHEMA)
      expect(settled.find((r) => r.name === INDEX.MATCH)?.valid).toBe(true)
    }, 180_000)

    it('the closing check refuses an INVALID or a missing index (CR-M-1)', async () => {
      const before = await addedIndexes(SCHEMA)
      const { finalCheck } = doBlocks()
      await client.query(finalCheck)
      await invalidate(INDEX.AVAILABILITY)
      await expect(client.query(finalCheck)).rejects.toThrow(
        /idx_job_dirty_work_pending_availability is INVALID/,
      )
      await client.query(`DROP INDEX ${SCHEMA}.${INDEX.AVAILABILITY}`)
      await expect(client.query(finalCheck)).rejects.toThrow(
        /idx_job_dirty_work_pending_availability is MISSING/,
      )
      await applyFile()
      expect(await addedIndexes(SCHEMA)).toEqual(before)
    })

    it('a generic plan of each real claim can use its own partition index, never the other', async () => {
      await client.query(`SET plan_cache_mode = force_generic_plan`)
      // Only the two partial indexes exist here; with seqscan priced out, the planner takes an
      // index iff its predicate is provably implied by the claim's conjuncts.
      await client.query(`SET enable_seqscan = off`)
      const match = await claimPlanIndexes('MATCH')
      const availability = await claimPlanIndexes('AVAILABILITY')
      expect(match).toContain(INDEX.MATCH)
      expect(match).not.toContain(INDEX.AVAILABILITY)
      expect(availability).toContain(INDEX.AVAILABILITY)
      expect(availability).not.toContain(INDEX.MATCH)
    })

    it('a transaction open longer than the sweep lock_timeout does not fail the build (CR-M-1 of PR #1333)', async () => {
      // Real timeouts, not scaled-down ones: the snapshot is held 12 s, past the sweep's 10 s
      // lock_timeout and well inside the CIC's 5 min one. Under one session-wide 10 s timeout the
      // CIC's wait for this older snapshot is cancelled and the apply fails.
      const holder = await pool.connect()
      try {
        await client.query(
          `DROP INDEX IF EXISTS ${INDEXES.map((name) => `${SCHEMA}.${name}`).join(', ')}`,
        )
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
      expect((await addedIndexes(SCHEMA)).every((r) => r.valid)).toBe(true)
    }, 60_000)
  },
)
