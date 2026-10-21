import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertBackdatedJobQueueActionAsTableOwner } from '../database/__test-helpers__/backdated-job-queue-action'
import {
  applyDeployDdlFile,
  APPEND_ONLY_TRIGGERS_DDL,
  dropRolesCreated,
  installDeployRoles,
} from '../database/__test-helpers__/deploy-ddl-preconditions'
import type { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { JobQueueActionRetentionCronService } from './job-queue-action-retention.cron'

/**
 * r5 Task 1.4a — the purge CALLER, against the real catalog.
 *
 * What only a real database can prove, and what this file therefore exists for:
 *
 *   AC1 — the caller actually invokes `crm_retention_purge_job_queue_actions()`
 *         and gets a row count back. The task said to VERIFY, not assume, that an
 *         application connection needs no privilege change: the function is
 *         SECURITY DEFINER owned by `crm_retention_owner` and `EXECUTE` is granted
 *         to `crm_app` by name, so the DELETE is admitted by the append-only
 *         trigger (`current_user = 'crm_retention_owner'`) even though the caller
 *         is not that role. `as crm_app` below is that verification.
 *   AC2 — the period is the database's, not the caller's: the same argument-free
 *         call leaves a row one day short of two years and removes one a day past
 *         it. If a TypeScript copy of the interval ever appeared, it could disagree
 *         with the SQL and these two cases would not notice — which is exactly why
 *         there must not be one.
 *   AC6 — a row younger than two years is NOT deleted, observed THROUGH the caller.
 *
 * The 1.3b suite (`database/job-queue-append-only.integration.spec.ts`) already
 * pins the same boundary at the SQL level and the trigger's refusals; this file
 * does not restate those. It covers the seam 1.3b could not: the API-side call.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_r14a \
 *     pnpm --filter @crm/api exec vitest run job-queue-action-retention.cron.integration.spec
 *
 * The suite installs the deploy roles from the shipped roles file and applies the
 * shipped triggers DDL itself (both are preconditions it must not inherit from
 * whichever sibling vitest happened to sequence first), and `afterAll` drops exactly
 * the roles this run created.
 *
 * DB-SKIP-GUARD: with no reachable DATABASE_URL every case returns early.
 */

const TAG = `it1.4a-${randomUUID().slice(0, 8)}`

let pool: Pool
let rolesCreatedHere: readonly string[] = []
let actorId = ''
let opportunityId = ''
let ready = false

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

let seq = 0
const nextTag = () => {
  seq += 1
  return `${TAG}-${seq}`
}

/**
 * An action-log row of a chosen age — A STATE NO WRITER CAN PRODUCE, and the name says
 * so at every call site.
 *
 * `created_at` can be neither supplied at INSERT time (`trg_job_queue_actions_created_at_now`
 * overrides it) nor set afterwards (the append-only trigger refuses every UPDATE but the
 * redaction). Both of those are the feature. A suite about a two-year boundary still needs
 * a row on each side of it, so the age is manufactured as the TABLE OWNER with the
 * `created_at` guard off for exactly the one INSERT — see the shared helper's docblock for
 * why the window is a transaction rather than a block.
 *
 * Deliberately NOT a general "insert an action" helper: every row this file creates is
 * aged on purpose, and a future test that wants an ordinary row should write its own
 * INSERT and get `now()`, as production does.
 */
async function newBackdatedActionAsTableOwner(age: string): Promise<string> {
  return insertBackdatedJobQueueActionAsTableOwner(pool, {
    actorId,
    opportunityId,
    age,
    idempotencyKey: nextTag(),
    reason: `${TAG} reason`,
  })
}

const countOf = async (id: string): Promise<number> => {
  const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`, [id])
  return rows[0].n as number
}

/** The cron service bound to a connection that has become `crm_app`, as production is. */
async function asCrmApp<T>(
  fn: (svc: JobQueueActionRetentionCronService) => Promise<T>,
): Promise<T> {
  const appPool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 1 })
  try {
    await appPool.query(`SET ROLE crm_app`)
    const db = { db: drizzle(appPool, { schema }) } as unknown as DatabaseService
    return await fn(new JobQueueActionRetentionCronService(db))
  } finally {
    await appPool.end()
  }
}

describe('JobQueueActionRetentionCronService — against the real catalog', () => {
  beforeAll(async () => {
    if (!(await hasDatabaseUrl())) return
    await assertRealDbSchema([{ table: 'job_queue_actions', column: 'idempotency_key' }])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db, version() AS v')
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    // Recorded in the run output on purpose: a writing spec states which database it
    // writes to, because two PostgreSQL servers answer on 5432 on this machine.
    console.log(`[1.4a] database=${rows[0].db} ${String(rows[0].v).split(',')[0]}`)

    rolesCreatedHere = await installDeployRoles(pool)
    await applyDeployDdlFile(pool, APPEND_ONLY_TRIGGERS_DDL)

    const user = await q(
      `INSERT INTO users (email, display_name, role) VALUES ($1, $2, 'HR') RETURNING id`,
      [`${TAG}@test.spec`, `${TAG} actor`],
    )
    actorId = user.rows[0].id as string
    const opp = await q(
      `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
      [nextTag()],
    )
    opportunityId = opp.rows[0].id as string

    // `crm_app` must be able to reach the table at all to call a definer function
    // that touches it; the production grants file gives it that, and this scratch
    // database gets the same thing rather than inheriting it from a sibling suite.
    await q(`GRANT USAGE ON SCHEMA public TO crm_app`)
    await q(`GRANT SELECT, INSERT ON job_queue_actions TO crm_app`)
    await q(`GRANT SELECT, DELETE ON job_queue_actions TO crm_retention_owner`)

    // No service is built on THIS connection on purpose: every case below goes
    // through `asCrmApp`, because a purge invoked by the superuser that owns the
    // scratch database would prove nothing about the application's privileges.
    ready = true
  }, 120_000)

  afterAll(async () => {
    if (!ready) {
      await pool?.end()
      return
    }
    try {
      // The log is append-only, so the fixture rows cannot be deleted by a plain
      // DELETE — the suite disables the two action triggers as the table owner for
      // the length of its cleanup, the way the 1.3b suite does, and re-enables them.
      await q(`ALTER TABLE job_queue_actions DISABLE TRIGGER trg_job_queue_actions_append_only`)
      await q(`DELETE FROM job_queue_actions WHERE idempotency_key LIKE $1`, [`${TAG}%`])
      await q(
        `ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only`,
      )
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opportunityId])
      await q(`DELETE FROM users WHERE id = $1`, [actorId])
      await q(`REVOKE SELECT, INSERT ON job_queue_actions FROM crm_app`)
      await dropRolesCreated(pool, rolesCreatedHere)
    } finally {
      await pool.end()
    }
  }, 120_000)

  it('AC1: the caller invokes the function as crm_app and needs no privilege change', async () => {
    if (!ready) return
    // The claim PR #1026 made and this task was told to verify rather than assume.
    const expired = await newBackdatedActionAsTableOwner('2 years 1 day')
    const purged = await asCrmApp((svc) => svc.purgeExpiredActions())

    expect(purged).toBeGreaterThanOrEqual(1)
    expect(typeof purged).toBe('number')
    expect(await countOf(expired)).toBe(0)
  })

  it('AC6/AC2: a row one day SHORT of two years is NOT deleted', async () => {
    if (!ready) return
    // 729 days: inside the window, and well past one year, so an interval narrowed
    // to '1 year' on either side of the mirror would show up here instead of
    // silently agreeing. The caller passes no period — only the SQL knows it.
    const young = await newBackdatedActionAsTableOwner('729 days')
    await asCrmApp((svc) => svc.purgeExpiredActions())
    expect(await countOf(young)).toBe(1)
  })

  it('AC2: the same argument-free call deletes a row one day PAST two years', async () => {
    if (!ready) return
    const expired = await newBackdatedActionAsTableOwner('2 years 1 day')
    await asCrmApp((svc) => svc.purgeExpiredActions())
    expect(await countOf(expired)).toBe(0)
  })

  it('AC1: the count the caller reports is the number of rows actually removed', async () => {
    if (!ready) return
    // Three expired rows and a young one: the reported count must be exactly the
    // three, which is what makes the log line evidence rather than decoration.
    const expired = [
      await newBackdatedActionAsTableOwner('3 years'),
      await newBackdatedActionAsTableOwner('2 years 2 days'),
      await newBackdatedActionAsTableOwner('10 years'),
    ]
    const young = await newBackdatedActionAsTableOwner('30 days')

    const purged = await asCrmApp((svc) => svc.purgeExpiredActions())
    expect(purged).toBe(3)
    for (const id of expired) expect(await countOf(id)).toBe(0)
    expect(await countOf(young)).toBe(1)
  })

  it('AC1: the @Cron handler survives a real failure without rethrowing', async () => {
    if (!ready) return
    // The shape a dropped EXECUTE grant takes in production: 42501 from the real
    // database, not a stubbed rejection. The scheduler must stay alive.
    await q(
      `REVOKE EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() FROM crm_app`,
    )
    try {
      await expect(
        asCrmApp(async (svc) => {
          await expect(svc.purgeExpiredActions()).rejects.toThrow()
          return svc.handleRetention()
        }),
      ).resolves.toBeUndefined()
    } finally {
      await q(`GRANT EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() TO crm_app`)
    }
  })
})
