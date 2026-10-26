import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, LedgerKit, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from './job-run-ledger'

/**
 * r5 Task 2.5 T5 — the three ledger additions the collection window needs, against a REAL Postgres
 * AS `crm_app`: `claimDue({ onlyTypes })`, `countDue`, `closeCycle`.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.window.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger

describe.skipIf(!hasDatabaseUrl())('ledger additions for the collection window (T5)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API', 'JSEARCH_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T5 spec', 'ADMIN') RETURNING id`,
      [`t5spec-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE email = $1`, [
        `t5spec-${TAG}@example.test`,
      ])
    } finally {
      await session.close()
    }
  })

  it('claimDue({ onlyTypes }) claims only the named types', async () => {
    const remotive = await kit.reporting({ type: 'REMOTIVE_API' })
    const jsearch = await kit.reporting({ type: 'JSEARCH_API' })
    const ids = [remotive, jsearch]
    const { claimed } = await ledger.claimDue({
      cycleId: await kit.scheduledCycle(),
      owner: 'spec-worker',
      limit: 5,
      onlyIds: ids,
      onlyTypes: ['JSEARCH_API'],
    })
    expect(claimed.map((c) => c.sourceId)).toEqual([jsearch])
    expect((await fx.runs(remotive)).length).toBe(0)
  })

  it('a type that is not a type name is refused, never interpolated', async () => {
    await expect(
      ledger.countDue({ onlyTypes: ["X'); DROP TABLE job_sources;--" as never] }),
    ).rejects.toThrow(RangeError)
  })

  it('countDue counts due sources of the scope, claimable or not', async () => {
    const hostKey = fx.host('count')
    const running = await kit.reporting({ type: 'REMOTIVE_API', hostKey })
    const behind = await kit.reporting({ type: 'REMOTIVE_API', hostKey })
    const other = await kit.reporting({ type: 'JSEARCH_API' })
    await kit.claimOne(running)
    const ids = [running, behind, other]
    // `running` has a STARTED run but its next_attempt_at is still in the past until it finishes:
    // it, `behind` (host busy) and `other` all pass the due predicate.
    expect(await ledger.countDue({ onlyIds: ids })).toBeGreaterThanOrEqual(2)
    expect(await ledger.countDue({ onlyIds: [behind] })).toBe(1)
    expect(await ledger.countDue({ onlyIds: ids, onlyTypes: ['JSEARCH_API'] })).toBe(1)
    expect(await ledger.countDue({ onlyIds: ids, onlyTypes: ['REMOTIVE_API'] })).toBe(2)
    // a claim that cannot happen today (host busy) leaves `behind` due: the window keeps waiting
    const { claimed } = await ledger.claimDue({
      cycleId: await kit.scheduledCycle(),
      owner: 'spec-worker',
      limit: 5,
      onlyIds: [behind],
    })
    expect(claimed).toEqual([])
    expect(await ledger.countDue({ onlyIds: [behind] })).toBe(1)
  })

  it('closeCycle closes an open cycle once, and the cycle then refuses claims', async () => {
    const cycleId = await kit.scheduledCycle()
    expect(await ledger.closeCycle(cycleId)).toBe(true)
    expect(await ledger.closeCycle(cycleId)).toBe(false) // idempotent: the first instant stays
    const { rows } = await session.admin.query(
      `SELECT status, closed_at IS NOT NULL AS closed FROM job_collection_cycles WHERE id = $1`,
      [cycleId],
    )
    expect(rows[0]).toEqual({ status: 'CLOSED', closed: true })
    await expect(
      ledger.claimDue({ cycleId, owner: 'spec-worker', limit: 1, onlyIds: [] }),
    ).rejects.toThrow('no open cycle')
    await expect(ledger.closeCycle('not-a-uuid')).rejects.toThrow(RangeError)
  })

  it('a second replica opening the same scheduled cycle gets the same row; closing keeps the first instant', async () => {
    const key = fx.cycleKey()
    const a = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })
    const b = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })
    expect(b.cycleId).toBe(a.cycleId)
    await ledger.closeCycle(a.cycleId)
    const first = await session.admin.query(
      `SELECT closed_at FROM job_collection_cycles WHERE id = $1`,
      [a.cycleId],
    )
    await ledger.closeCycle(b.cycleId)
    const second = await session.admin.query(
      `SELECT closed_at FROM job_collection_cycles WHERE id = $1`,
      [a.cycleId],
    )
    expect(second.rows[0].closed_at).toEqual(first.rows[0].closed_at)
  })
})
