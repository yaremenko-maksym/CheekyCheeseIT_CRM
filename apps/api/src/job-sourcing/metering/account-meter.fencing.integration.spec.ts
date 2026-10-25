import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, LedgerKit, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun } from '../../test/run-aging'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { RunFencedError } from '../ownership/run-ownership'
import { createAccountMeter } from './account-meter.store'

/**
 * r5 Task 2.5 T3 AC 1 — the SR-H-1 precondition, ENFORCED. The 3.5a characterisation case
 * ("TWO live executors of one attempt SHARE a reservation") measured 4 units leaving the account
 * while 2 were charged, because nothing could tell two executors of one attempt apart. A run-bound
 * binding now carries the ledger's owner token and epoch, so the second executor of the same
 * attempt is refused with RUN_FENCED before it reserves or marks anything sent, and spend equals
 * charge. Against real Postgres, as `crm_app`.
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe.skipIf(!hasDatabaseUrl())('the meter is fenced by the run ledger (T3 AC 1)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['JSEARCH_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T3 meter spec', 'ADMIN') RETURNING id`,
      [`t3meter-${TAG}@example.test`],
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

  async function claimedMeteredRun(limit: number | null) {
    const meterId = await fx.meter(fx.accountKey(`m-${randomUUID().slice(0, 6)}`), limit)
    const s = await kit.reporting(
      { type: 'JSEARCH_API', accountMeterId: meterId },
      { quotaDeclared: true },
    )
    return { meterId, run: await kit.claimOne(s) }
  }

  it('a second executor of the same attempt is refused RUN_FENCED; spend equals charge', async () => {
    const { meterId, run } = await claimedMeteredRun(10)
    const db = drizzle(session.pool, { schema })
    const binding = {
      accountKey: run.accountKey,
      windows: { REQUEST: 'DAY' as const },
      attemptId: run.attemptId,
      cycleId: run.cycleId,
      runId: run.runId,
    }
    const owner = createAccountMeter(db, {
      ...binding,
      ownerToken: run.ownerToken,
      fencingEpoch: run.fencingEpoch,
    })
    // The same attempt, a different executor: another token (a stale process), then the right
    // token at a superseded epoch.
    const intruders = [
      createAccountMeter(db, {
        ...binding,
        ownerToken: 'spec-worker:other',
        fencingEpoch: run.fencingEpoch,
      }),
      createAccountMeter(db, {
        ...binding,
        ownerToken: run.ownerToken,
        fencingEpoch: run.fencingEpoch + 1,
      }),
    ]

    const a = (await owner.reserve('REQUEST', 2))!
    for (const intruder of intruders) {
      expect(await rejection(intruder.reserve('REQUEST', 2))).toBeInstanceOf(RunFencedError)
      expect(await rejection(intruder.markSent(a))).toBeInstanceOf(RunFencedError)
      expect(await rejection(intruder.reconcile(a, 'USED'))).toBeInstanceOf(RunFencedError)
    }
    await owner.markSent(a)
    await owner.reconcile(a, 'USED')

    // One request left the account and one is charged: no shared hold, no silent no-op.
    expect(await fx.counters(meterId)).toEqual({ used: 2, reserved: 0, uncertain: 0 })
    const rows = await fx.reservations(run.runId)
    expect(rows.map((r) => [r.status, r.used_amount])).toEqual([['USED', 2]])
  })

  it('reserve writes run_id from the asserted run row', async () => {
    const { run } = await claimedMeteredRun(null)
    const r = (await ledger.meterFor(run, { REQUEST: 'DAY' }).reserve('REQUEST', 1))!
    const { rows } = await session.admin.query(
      `SELECT run_id FROM job_account_meter_reservations WHERE id = $1`,
      [r.id],
    )
    expect(rows[0].run_id).toBe(run.runId)
  })

  it('an executor whose lease expired is fenced before recovery even runs', async () => {
    const { meterId, run } = await claimedMeteredRun(null)
    const meter = ledger.meterFor(run, { REQUEST: 'DAY' })
    const r = (await meter.reserve('REQUEST', 3))!
    await ageRun(session.admin, run.runId, 10 * 60_000)
    expect(await rejection(meter.markSent(r))).toBeInstanceOf(RunFencedError)
    await ledger.recoverExpired()
    // Provably unsent, so released, and nothing charged.
    expect(await fx.counters(meterId)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
  })

  it('a binding naming another account than its run is refused', async () => {
    const { run } = await claimedMeteredRun(null)
    const other = fx.accountKey('elsewhere')
    await fx.meter(other, null)
    const meter = createAccountMeter(drizzle(session.pool, { schema }), {
      accountKey: other,
      windows: { REQUEST: 'DAY' },
      attemptId: run.attemptId,
      cycleId: run.cycleId,
      runId: run.runId,
      ownerToken: run.ownerToken,
      fencingEpoch: run.fencingEpoch,
    })
    const err = (await rejection(meter.reserve('REQUEST', 1))) as { code?: string }
    expect(err.code).toBe('INVALID_BINDING')
  })
})
