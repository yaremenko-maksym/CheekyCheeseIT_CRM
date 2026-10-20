import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HrAccessService } from '../common/hr-access.service'
import type { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { DouRssProvider } from './dou.provider'
import { JobSourcingService } from './job-sourcing.service'

/**
 * C-08 (r5 §1.4) — the SHAPE of the retention DELETE, pinned.
 *
 * WHY THIS IS NOT A UNIT TEST, AND NOT A DUPLICATE OF THE EXISTING CASES. The
 * behaviour of `purgeStalePostings` is already covered by
 * `job-sourcing.integration.spec.ts` (applied kept, rejected kept, IN_PROGRESS and
 * DISMISSED kept, old NEW dropped) and those assertions are UNCHANGED by the
 * rewrite — which is the point: they pass identically before and after, so they
 * cannot tell the two implementations apart. C-08 is not a behaviour change, it is a
 * COMPLEXITY change, and the only thing that distinguishes the fixed version from
 * the regression is the statement the database receives. So this spec asserts on
 * exactly that, captured from drizzle's own logger rather than re-derived by the
 * test, and the data in the table is deliberately irrelevant.
 *
 * What would go red: reverting to `selectDistinct` + `notInArray` emits an `in`/`not
 * in` with one bind parameter per decided posting, and no `not exists` at all.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`.
 * DB-SKIP-GUARD: with no reachable DATABASE_URL every case returns early.
 */

let pool: Pool
let service: JobSourcingService
let captured: string[] = []
let ready = false

describe('purgeStalePostings — the emitted statement (C-08)', () => {
  beforeAll(async () => {
    if (!(await hasDatabaseUrl())) return
    await assertRealDbSchema([{ table: 'job_postings', column: 'queue_status' }])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await pool.query('SELECT current_database() AS db')
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    console.log(`[C-08] database=${rows[0].db}`)

    const db = drizzle(pool, {
      schema,
      logger: {
        logQuery: (query: string) => {
          captured.push(query)
        },
      },
    })
    const dbSvc = { db } as unknown as DatabaseService
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), new DouRssProvider())
    ready = true
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
  })

  it('issues ONE statement — no preliminary SELECT of every decided posting id', async () => {
    if (!ready) return
    captured = []
    await service.purgeStalePostings()

    // The regression this kills: the old shape ran a `select distinct` first and
    // carried its whole result back into the next statement.
    expect(captured).toHaveLength(1)
    expect(captured[0]!.toLowerCase()).not.toContain('select distinct')
  })

  it('is a correlated NOT EXISTS against job_suggestions, with no id list', async () => {
    if (!ready) return
    captured = []
    await service.purgeStalePostings()
    const sql = captured[0]!.toLowerCase()

    expect(sql).toContain('not exists')
    expect(sql).toContain('job_suggestions')
    // Correlated: the subquery references the outer row rather than standing alone.
    expect(sql).toContain('"job_postings"."id"')
    // And the three clauses whose behaviour must not change are all still there.
    // The two statuses arrive as BIND PARAMETERS (`in ($3, $4)`), which is why this
    // asserts on the `in` rather than on the literals: drizzle never inlines them.
    expect(sql).toContain('"collected_at" <')
    expect(sql).toContain('"queue_status" =')
    expect(sql).toContain('"job_suggestions"."status" in (')
  })

  it('the parameter count does not grow with the number of decided suggestions', async () => {
    if (!ready) return
    // The actual unboundedness C-08 names: under the old shape each decided posting
    // became another bind parameter. Here the statement's parameters are fixed, so
    // the same statement text appears whatever the table holds.
    captured = []
    await service.purgeStalePostings()
    const statement = captured[0]!

    // FOUR placeholders, always: the cutoff, 'NEW', and the two decided statuses.
    // Under the old shape there was one more for every decided posting in the table,
    // so this count IS the unboundedness, expressed as an assertion.
    const placeholders = new Set(statement.match(/\$\d+/g) ?? [])
    expect([...placeholders].sort()).toEqual(['$1', '$2', '$3', '$4'])

    // And it is the same statement text on a second run, whatever the table holds.
    captured = []
    await service.purgeStalePostings()
    expect(captured[0]).toBe(statement)
  })
})
