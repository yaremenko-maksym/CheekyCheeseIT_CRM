import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * Senior roles 3b Task 3.4 / 6.1 — the forward DDL
 * `manual/2026-11-18_job_opportunities_role_pending_index.sql` against a REAL Postgres.
 *
 * The file adds ONE object: `idx_job_opportunities_role_pending`, a PARTIAL btree index on
 * `job_opportunities (last_observed_at DESC, id) WHERE role_status = 'PENDING'` — the index the
 * role-AI candidate scan reads (`job-sourcing/role-ai/role-ai.store.ts`, `candidates`:
 * `WHERE o.role_status = 'PENDING' AND … ORDER BY o.last_observed_at DESC, o.id LIMIT n`).
 *
 * Unlike `2026-11-02_job_dirty_work_pending_partial.sql` this is NOT a CONCURRENTLY build: the
 * deploy applies the file in its own `psql -v ON_ERROR_STOP=1 --single-transaction` call, so the
 * spec applies it in one explicit BEGIN/COMMIT, the way that call does.
 *
 * WHY THE `NULLS FIRST` ASSERTIONS ARE THE POINT OF THIS SPEC
 * ----------------------------------------------------------
 * `ORDER BY last_observed_at DESC` means DESC NULLS FIRST, which is what the file's plain
 * `last_observed_at DESC` builds. Drizzle's bare `.desc()` instead emits `DESC NULLS LAST`, and an
 * index in that order CANNOT serve the query's sort: measured on this branch, the plan for the
 * NULLS LAST variant is `Limit -> Sort -> Bitmap Heap Scan`, a full sort of the PENDING set — and
 * it stays that way even though `last_observed_at` is NOT NULL, because the planner does not
 * collapse the two null orderings for a NOT NULL column. So the index would exist, be used, and
 * still not do its job. Two assertions pin it: the indexdef equals what `db:push` declares in
 * `public` (which is what `.desc().nullsFirst()` in `schema/job-opportunities.ts` renders), and
 * the plan carries NO `Sort` node.
 *
 * AC: the file applies twice without error; the index exists with that predicate and column order;
 * the candidate-shaped query can use it. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run role-pending-index-forward-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-18_job_opportunities_role_pending_index.sql',
)
const SCHEMA = 'ddl_job_opportunities_role_pending'
const TABLE = 'job_opportunities'
const INDEX = 'idx_job_opportunities_role_pending'
/** Enough rows that a seq scan is the planner's natural choice, so using the index is a finding. */
const SEEDED_ROWS = 5_000

let pool: Pool
let client: PoolClient

/** Applies the file as the deploy's own `--single-transaction` call does: one BEGIN/COMMIT. */
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

/** The one index the file adds, read from `schema` and schema-normalised for comparison. */
async function addedIndex(schema: string): Promise<{ name: string; def: string } | undefined> {
  const { rows } = await client.query(
    `SELECT indexname AS name, indexdef AS def
       FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
    [schema, TABLE, INDEX],
  )
  const row = rows[0]
  if (row === undefined) return undefined
  return { name: String(row.name), def: String(row.def).split(`${schema}.`).join('public.') }
}

/**
 * The plan of the candidate scan's shape — its predicate, its ORDER BY and its LIMIT, which is
 * everything the index has to answer. `enable_seqscan = off` makes the question "CAN the planner
 * use it", not "is it cheaper today on this row count"; both settings are LOCAL to the
 * transaction, which is rolled back.
 */
async function candidatePlan(): Promise<string> {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL enable_seqscan = off`)
    const { rows } = await client.query(
      `EXPLAIN (COSTS OFF) SELECT id FROM ${SCHEMA}.${TABLE}
        WHERE role_status = 'PENDING' ORDER BY last_observed_at DESC, id LIMIT 50`,
    )
    return rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n')
  } finally {
    await client.query('ROLLBACK')
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'senior roles 3b forward DDL: PENDING candidate partial index',
  () => {
    beforeAll(async () => {
      // `public` is the reference side (built by db:push), so the role columns must be there.
      await assertRealDbSchema([{ table: TABLE, column: 'role_status' }])
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      client = await pool.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}, public`)
      // The stub carries exactly the columns the index touches, with the real nullability:
      // `last_observed_at` is NOT NULL in the schema, which is what makes the NULLS LAST trap
      // above survivable-looking and therefore worth asserting against.
      await client.query(
        `CREATE TABLE ${SCHEMA}.${TABLE} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           last_observed_at timestamptz NOT NULL DEFAULT now(),
           role_status text)`,
      )
      await applyFile()
      await client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (last_observed_at, role_status)
         SELECT now() - (g || ' minutes')::interval,
                CASE WHEN g % 10 = 0 THEN 'PENDING' ELSE 'RULE' END
           FROM generate_series(1, $1) g`,
        [SEEDED_ROWS],
      )
      await client.query(`ANALYZE ${SCHEMA}.${TABLE}`)
    }, 120_000)

    afterAll(async () => {
      if (pool === undefined) return
      try {
        await client?.query(`SET search_path = public`)
        await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        client?.release()
      } finally {
        await pool.end()
      }
    })

    it('is PARTIAL on (last_observed_at DESC, id) WHERE role_status = PENDING', async () => {
      const ours = await addedIndex(SCHEMA)
      expect(ours).toBeDefined()
      // The column ORDER and the null ordering, not merely the membership.
      expect(ours?.def).toContain('USING btree (last_observed_at DESC, id)')
      expect(ours?.def).toContain("WHERE (role_status = 'PENDING'::text)")
      // `DESC NULLS LAST` would be a different index that cannot serve the query's ORDER BY.
      expect(ours?.def).not.toContain('NULLS LAST')
      expect(ours?.def).not.toContain('UNIQUE')
    })

    it('equals what db:push declares for the same index in public', async () => {
      const reference = await addedIndex('public')
      // Not an `undefined === undefined` pass: an absent reference means `public` was never
      // db:push'd from this branch's schema, and the comparison would prove nothing.
      expect(
        reference,
        `${INDEX} missing from public — run db:push against this database`,
      ).toBeDefined()
      expect(await addedIndex(SCHEMA)).toEqual(reference)
    })

    it('applies a second time without error and changes nothing (IF NOT EXISTS)', async () => {
      const before = await addedIndex(SCHEMA)
      await applyFile()
      expect(await addedIndex(SCHEMA)).toEqual(before)
    })

    it('the candidate-shaped query can use it, with no sort of the PENDING set', async () => {
      const plan = await candidatePlan()
      expect(plan).toContain(INDEX)
      // The ORDER BY is answered by the index's own order; a `Sort` here means it is not.
      expect(plan).not.toContain('Sort')
    })
  },
)
