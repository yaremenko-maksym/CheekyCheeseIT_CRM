import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { splitSqlStatements } from './manual-sql-statements'

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
 * spec applies it in one explicit BEGIN/COMMIT with each statement sent as its own command
 * inside it, the way that call does.
 *
 * WHY THE `NULLS FIRST` ASSERTIONS ARE THE POINT OF THIS SPEC
 * ----------------------------------------------------------
 * `ORDER BY last_observed_at DESC` means DESC NULLS FIRST, which is what the file's plain
 * `last_observed_at DESC` builds. Drizzle's bare `.desc()` instead emits `DESC NULLS LAST`, and an
 * index in that order CANNOT serve the query's sort: measured on this branch, the plan for the
 * NULLS LAST variant is `Limit -> Sort -> Bitmap Heap Scan`, a full sort of the PENDING set — and
 * it stays that way even though `last_observed_at` is NOT NULL, because the planner does not
 * collapse the two null orderings for a NOT NULL column. So the index would exist, be used, and
 * still not do its job. Three assertions pin it: the first key column's `pg_index.indoption` is
 * DESC | NULLS FIRST (the only POSITIVE pin — see `firstKeyIndoption`), the indexdef equals what
 * `db:push` declares in `public` (which is what `.desc().nullsFirst()` in
 * `schema/job-opportunities.ts` renders), and the plan carries NO `Sort` node.
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
/**
 * Enough rows (one PENDING in ten) that the plan below is about this index rather than about a
 * table too small for the planner to have alternatives. It is NOT a claim that the cost model
 * would otherwise choose a seq scan — measured on a scratch database it picks the index here even
 * with `enable_seqscan` left on. What `candidatePlan`'s `enable_seqscan = off` buys is that the
 * question stays "CAN the index serve this query" on any row count: a plan without the index, or
 * one carrying a `Sort`, is the finding.
 */
const SEEDED_ROWS = 5_000

/** `pg_index.indoption` bits of a key column: 1 = DESC, 2 = NULLS FIRST. */
const DESC_NULLS_FIRST = 3

let pool: Pool
let client: PoolClient

/**
 * Applies the file as the deploy's own `psql -v ON_ERROR_STOP=1 --single-transaction` call does:
 * one BEGIN/COMMIT, with every statement sent as its OWN command inside it.
 *
 * NOT `client.query(wholeFile)`. A multi-statement simple query models the transaction but not
 * the statement boundaries, and `__test-helpers__/deploy-ddl-preconditions.ts` states that
 * distinction as a rule with its own rationale. The two are equivalent for this file's two
 * statements; splitting is what keeps them equivalent once a third is added.
 *
 * `applyDeployDdlFile` from that module is deliberately NOT reused here: it connects its own
 * pooled client (so it would not see this spec's `search_path` and would hit `public`) and opens
 * no transaction (so this file's `SET LOCAL lock_timeout` would be inert).
 */
async function applyFile(): Promise<void> {
  await client.query('BEGIN')
  try {
    for (const statement of splitSqlStatements(readFileSync(FILE, 'utf8')))
      await client.query(statement)
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
 * The FIRST key column's sort flags, read from `pg_index.indoption` rather than from the deparsed
 * text. This is the only POSITIVE pin of the null ordering available: `pg_get_indexdef` prints a
 * DESC key's default `NULLS FIRST` as a bare `DESC`, so the text can say `NULLS LAST` is absent
 * and nothing more. The catalog separates them — measured on PostgreSQL 16.15, this index's
 * `last_observed_at DESC` is 3 (DESC | NULLS FIRST) and the `DESC NULLS LAST` drift is 1.
 * `indoption` is an int2vector, so the subscript is 0-based.
 */
async function firstKeyIndoption(schema: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT i.indoption[0]::int AS opt
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, INDEX],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`${INDEX} absent from ${schema}: nothing to read`)
  return Number(row.opt)
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
      // The null ordering, pinned POSITIVELY from the catalog and asserted FIRST: the text
      // assertions below cannot distinguish `DESC` from `DESC NULLS FIRST`, and under a
      // NULLS LAST drift the `USING btree` one throws before this could run.
      expect(
        await firstKeyIndoption(SCHEMA),
        `${INDEX}: last_observed_at must be DESC NULLS FIRST (indoption 3). ` +
          'A bare Drizzle `.desc()` builds DESC NULLS LAST, which is 1.',
      ).toBe(DESC_NULLS_FIRST)
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
