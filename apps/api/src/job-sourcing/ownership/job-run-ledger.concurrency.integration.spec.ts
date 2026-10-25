import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  identityObservations,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun } from '../../test/run-aging'
import { recordHostBan } from '../scheduling/host-state'
import { type ClaimedRun, JobRunLedger } from './job-run-ledger'

/**
 * r5 Task 2.5 T3 AC 6 (SR-M-10) — EVERY row of the ADR's lock-acquisition table, at once, for 1,000
 * iterations, with no deadlock. Each iteration fires, concurrently: openCycle, two claimDue loops,
 * claimSource, heartbeat, reserve, markSent -> reconcile, savePage from two sources with
 * overlapping records (in opposite order), finish, recoverExpired, sweepOrphanReservations,
 * resetFailures and T8's recordHostBan -- on rows chosen so they contend: one paid account shared
 * by the live run's meter, an orphan reservation the sweep settles, and two more sources that race
 * to claim it the moment its run finishes (the claim INSERT waiting on an uncommitted STARTED row),
 * one host being banned under a claimer, one page-table key set written by two runs.
 *
 * A deadlock surfaces as SQLSTATE 40P01 on one of the operations; the assertion is that none
 * occurred and that every operation either succeeded or refused in a designed way.
 * `T3_CONCURRENCY_ITERATIONS` lowers the count for a quick local look; the AC is 1,000.
 */
const TAG = randomUUID().slice(0, 8)
const ITERATIONS = Number(process.env['T3_CONCURRENCY_ITERATIONS'] ?? 1000)
const NS = `t3spec-${TAG}-cc`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger

const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; name?: string }
  return String(x.cause?.code ?? x.code ?? x.name ?? 'unknown')
}

describe.skipIf(!hasDatabaseUrl())('the lock-acquisition table, all at once (T3 AC 6)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API', 'JSEARCH_API']),
      catalog,
      { claimLockTimeoutMs: 1000 },
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T3 cc spec', 'ADMIN') RETURNING id`,
      [`t3cc-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it(`${ITERATIONS} iterations, no deadlock`, async () => {
    const app = drizzle(session.pool, { schema })
    const acct = fx.accountKey('cc')
    const meterId = await fx.meter(acct, null)
    const sharedHost = fx.host('cc-shared')
    const banHost = fx.host('cc-ban')
    const metered = { type: 'JSEARCH_API' as const, accountMeterId: meterId }
    // A: the live metered run. B: a second live run (unmetered) whose pages overlap A's.
    const a = await kit.reporting({ ...metered, hostKey: sharedHost }, { quotaDeclared: true })
    const b = await kit.reporting()
    // C sits on A's busy host: the HOST_IDLE filter skips it before any host lock (SR-M-19), so it
    // is never claimed while A runs. D claims on the host being banned (the host-row lock).
    const c = await kit.reporting({ hostKey: sharedHost })
    const d = await kit.reporting({ hostKey: banHost })
    // E: claimed manually. F: a run whose lease is expired, for recovery. G: reset target.
    const e = await kit.reporting()
    const f = await kit.reporting()
    const g = await kit.reporting({ consecutiveFailures: 3 })
    // H1, H2 (CR-M-2): two more sources on A's PAID account, each on its own host, claimed while A
    // finishes -- H1 by the scheduled loops, H2 manually. Once A's finish commits, both pass "not
    // running" and race to insert: the loser's INSERT waits on the winner's uncommitted STARTED row
    // in the one-started-per-account index (the ADR's one cross-transaction wait) and is refused.
    const h1 = await kit.reporting(metered, { quotaDeclared: true })
    const h2 = await kit.reporting(metered, { quotaDeclared: true })
    const all = [a, b, c, d, e, f, g, h1, h2]
    const onAccount = { claimed: 0, conflicts: 0 }

    const errors = new Map<string, number>()
    // Keyed by the code, plus the first message line for anything unexpected, so a failure names
    // its statement.
    const deadlocks: string[] = []
    const note = (err: unknown) => {
      const code = codeOf(err)
      if (code === '40P01') deadlocks.push(String((err as Error).message))
      const k =
        code === 'RunFencedError'
          ? code
          : `${code}: ${String((err as Error).message)
              .split('\n')[0]
              ?.slice(0, 160)}`
      errors.set(k, (errors.get(k) ?? 0) + 1)
    }
    const settle = async (p: Promise<unknown>) => {
      try {
        await p
      } catch (err) {
        note(err)
      }
    }
    const ids = Array.from({ length: 6 }, (_, i) => `cc-${i}`)

    for (let i = 0; i < ITERATIONS; i += 1) {
      // --- set up the contended state ------------------------------------------------------
      const runA = await kit.claimOne(a)
      const runB = await kit.claimOne(b)
      const runF = await kit.claimOne(f)
      await ageRun(session.admin, runF.runId, 10 * 60_000)
      const meterA = ledger.meterFor(runA, { REQUEST: 'DAY' })
      const r1 = (await meterA.reserve('REQUEST', 1))!
      // An orphan on A's account: a terminal run's still-open reservation, for the sweep.
      // (None on the first iteration: A has no terminal run yet.)
      const orphan = await session.admin.query(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, run_id, cycle_id, amount, status)
           SELECT $1, $2, r.id, r.cycle_id, 1, 'RESERVED' FROM job_collection_runs r
            WHERE r.source_id = $3 AND r.outcome <> 'STARTED' ORDER BY r.fencing_epoch DESC LIMIT 1`,
        [meterId, `cc-orphan-${i}#REQUEST#1`, a],
      )
      await session.admin.query(
        `UPDATE job_account_meters SET reserved = reserved + $2 WHERE id = $1`,
        [meterId, orphan.rowCount ?? 0],
      )
      const scheduled = await kit.scheduledCycle()
      const manual = await kit.manualCycle()

      // --- every row of the table, at once ---------------------------------------------------
      const claimed: ClaimedRun[] = []
      const claimLoop = async () => {
        const res = await ledger.claimDue({
          cycleId: scheduled,
          owner: 'cc-worker',
          limit: 2,
          onlyIds: [c, d],
        })
        claimed.push(...res.claimed)
      }
      // A finishes, then H1 (scheduled) and H2 (manual) race for its account, while the rest of
      // the table is still in flight.
      const finishAThenClaimAccount = async () => {
        await ledger.finish(handleOf(runA), { outcome: 'SUCCEEDED', errorCode: null })
        await Promise.all([
          settle(
            ledger
              .claimDue({ cycleId: scheduled, owner: 'cc-worker', limit: 1, onlyIds: [h1] })
              .then((res) => claimed.push(...res.claimed)),
          ),
          settle(
            ledger
              .claimSource({ cycleId: manual, owner: 'cc-worker', sourceId: h2, actor: kit.actor })
              .then((m) => {
                if (m.kind === 'CLAIMED') claimed.push(m.run)
                else if (m.reason === 'CONFLICT') onAccount.conflicts += 1
              }),
          ),
        ])
      }
      await Promise.all([
        settle(ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })),
        settle(claimLoop()),
        settle(claimLoop()),
        settle(
          ledger
            .claimSource({ cycleId: manual, owner: 'cc-worker', sourceId: e, actor: kit.actor })
            .then((m) => {
              if (m.kind === 'CLAIMED') claimed.push(m.run)
            }),
        ),
        settle(ledger.heartbeat(handleOf(runA))),
        settle(meterA.reserve('REQUEST', 1)),
        settle(meterA.markSent(r1).then(() => meterA.reconcile(r1, 'USED'))),
        settle(
          ledger.savePage(handleOf(runA), {
            observations: identityObservations(ids, NS, 'JSEARCH_API'),
            checkpoint: specCheckpoint(i + 1, 'jsearch_api-1'),
          }),
        ),
        settle(
          ledger.savePage(handleOf(runB), {
            observations: identityObservations([...ids].reverse(), NS, 'REMOTIVE_API'),
            checkpoint: specCheckpoint(i + 1),
          }),
        ),
        settle(ledger.finish(handleOf(runB), { outcome: 'SUCCEEDED', errorCode: null })),
        settle(finishAThenClaimAccount()),
        settle(ledger.recoverExpired()),
        settle(ledger.sweepOrphanReservations()),
        settle(ledger.resetFailures({ sourceId: g, actor: kit.actor, reason: `cc ${i}` })),
        settle(
          recordHostBan(app, { hostKey: banHost, reason: 'HTTP_429', sourceId: d, floorHours: 0 }),
        ),
      ])

      // --- end everything this iteration started, and reset the rows -------------------------
      onAccount.claimed += claimed.filter((r) => r.sourceId === h1 || r.sourceId === h2).length
      for (const run of claimed) {
        await settle(ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null }))
      }
      await ledger.recoverExpired()
      await ledger.sweepOrphanReservations()
      await session.admin.query(
        `UPDATE job_sources SET next_attempt_at = clock_timestamp() - interval '1 hour',
                  cooldown_until = NULL, consecutive_failures = CASE WHEN id = $2 THEN 3 ELSE 0 END
            WHERE id = ANY($1::uuid[])`,
        [all, g],
      )
      await session.admin.query(
        `UPDATE job_source_hosts SET paused_until = NULL, pause_source_id = NULL, last_claimed_at = NULL
            WHERE host_key = ANY($1::text[])`,
        [[sharedHost, banHost]],
      )
    }

    const unexpected = [...errors.entries()].filter(([k]) => k !== 'RunFencedError')
    expect(deadlocks).toEqual([])
    expect(unexpected).toEqual([])
    // CR-M-2: A's account was claimed again inside the contended block, by exactly one of H1 / H2
    // every iteration (single flight per account) ...
    expect(onAccount.claimed).toBe(ITERATIONS)
    // ... and the loser was refused at the account index, not only filtered by "not running"
    // (measured: ~80 of 100 iterations; a lowered local iteration count may legitimately see none).
    expect({ sawConflict: onAccount.conflicts > 0 || ITERATIONS < 100 }).toEqual({
      sawConflict: true,
    })
    // Every run the iterations started is terminal, and nothing is left open on a terminal run.
    const { rows } = await session.admin.query(
      `SELECT
           (SELECT count(*)::int FROM job_collection_runs WHERE source_id = ANY($1::uuid[]) AND outcome = 'STARTED') AS started,
           (SELECT count(*)::int FROM job_account_meter_reservations res JOIN job_collection_runs r ON r.id = res.run_id
             WHERE r.source_id = ANY($1::uuid[]) AND res.status IN ('RESERVED', 'SENT', 'UNCERTAIN')) AS open`,
      [all],
    )
    expect(rows[0]).toEqual({ started: 0, open: 0 })
  }, 3_600_000)
})
