import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { splitSqlStatements } from './manual-sql-statements'
import { hasDatabaseUrl } from '../test/require-real-db'
import { type ClaimConsumer, dirtyWorkStatements } from '../job-sourcing/ownership/dirty-work.store'

/**
 * Backlog 347 (1) (STAGED/DARK) — the staged forward DDL
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

let session: CrmAppSession
let client: PoolClient

const unqualify = (text: string, schema: string) => text.split(`${schema}.`).join('public.')

async function applyFile(): Promise<void> {
  for (const statement of splitSqlStatements(readFileSync(FILE, 'utf8')))
    await client.query(statement)
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
  'backlog 347 staged DDL: reason-partition partial indexes on job_dirty_work',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
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
  },
)
