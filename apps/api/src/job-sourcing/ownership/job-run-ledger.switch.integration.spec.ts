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
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from './job-run-ledger'
import { RunFencedError } from './run-ownership'

/**
 * r5 Task 6.5 — the ADMIN source switch (`JobRunLedger.setEnabled`) and the access-pause clear in
 * `resetFailures`, against a REAL Postgres AS `crm_app`. Fixtures go through the migration role.
 *
 * Proves: enable is refused by readiness and by an access refusal; enable never moves the
 * cooldown, the failure counter, the reasons or the quota; the audit history is append-only and
 * retained; disable ends and fences an in-flight run without counting a failure.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped. NEVER `crm_db` (`openCrmAppSession`
 * refuses one).
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let catalog: SpecCatalog
let ledger: JobRunLedger
let kit: LedgerKit
let actor: string

/** The switch-relevant columns, read on the migration role (not through the code under test). */
async function state(id: string) {
  const { rows } = await session.admin.query(
    `SELECT enabled, consecutive_failures, last_error_code, readiness::text AS readiness,
            budget_used, admin_state_history,
            (extract(epoch FROM cooldown_until) * 1000)::float8 AS cooldown_ms,
            (extract(epoch FROM next_attempt_at) * 1000)::float8 AS next_ms
       FROM job_sources WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    enabled: boolean
    consecutive_failures: number
    last_error_code: string | null
    readiness: string
    budget_used: number
    admin_state_history: { kind: string; actor?: string; at?: string; clearedErrorCode?: string }[]
    cooldown_ms: number | null
    next_ms: number | null
  }
}

describe.skipIf(!hasDatabaseUrl())('the ADMIN source switch against Postgres, as crm_app', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API', 'ARBEITNOW_API'], ['ARBEITNOW_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T6.5 spec', 'ADMIN') RETURNING id`,
      [`t65spec-${TAG}@example.test`],
    )
    actor = rows[0].id as string
    kit = new LedgerKit(ledger, fx, catalog, actor)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [actor])
    } finally {
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
  })

  it('an unknown source is NOT_FOUND', async () => {
    expect(await ledger.setEnabled({ sourceId: randomUUID(), actor, enabled: true })).toEqual({
      kind: 'NOT_FOUND',
    })
  })

  describe('enable is blocked by readiness and by an access refusal', () => {
    it('a manifest entry that is not ready refuses NOT_READY, nothing written', async () => {
      const s = await kit.reporting({ enabled: false }, { entryReadiness: () => 'BLOCKED' })
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'REFUSED',
        reason: 'NOT_READY',
      })
      expect(await state(s)).toMatchObject({ enabled: false, admin_state_history: [] })
    })

    it('an unwired transport refuses NOT_READY (enable never grants readiness)', async () => {
      const s = await kit.reporting({ type: 'ARBEITNOW_API', enabled: false })
      expect((await ledger.setEnabled({ sourceId: s, actor, enabled: true })).kind).toBe('REFUSED')
      expect((await state(s)).enabled).toBe(false)
    })

    it('a stored BLOCKED readiness refuses NOT_READY and stays BLOCKED', async () => {
      const s = await kit.reporting({ enabled: false })
      await session.admin.query(
        `UPDATE job_sources SET readiness = 'BLOCKED', readiness_reason = 'key revoked' WHERE id = $1`,
        [s],
      )
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'REFUSED',
        reason: 'NOT_READY',
      })
      expect(await state(s)).toMatchObject({ enabled: false, readiness: 'BLOCKED' })
    })

    it('ACCESS_POLICY refuses AUTH_PAUSED until an audited reset clears it, then enable works', async () => {
      const s = await kit.reporting({ enabled: false })
      await session.admin.query(
        `UPDATE job_sources SET last_error_code = 'ACCESS_POLICY' WHERE id = $1`,
        [s],
      )
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'REFUSED',
        reason: 'AUTH_PAUSED',
      })
      expect(await state(s)).toMatchObject({ enabled: false, last_error_code: 'ACCESS_POLICY' })

      expect(await ledger.resetFailures({ sourceId: s, actor, reason: 'key rotated' })).toBe(true)
      const reset = await state(s)
      expect(reset.last_error_code).toBeNull()
      expect(reset.admin_state_history).toEqual([
        expect.objectContaining({
          kind: 'RESET_FAILURES',
          actor,
          clearedErrorCode: 'ACCESS_POLICY',
        }),
      ])

      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'SWITCHED',
        changed: true,
        cancelledRuns: 0,
      })
      expect((await state(s)).admin_state_history.map((e) => e.kind)).toEqual([
        'RESET_FAILURES',
        'ENABLED',
      ])
    })

    it('an ordinary reset keeps the old entry shape and the ordinary error code', async () => {
      const s = await kit.reporting({ consecutiveFailures: 3 })
      await session.admin.query(
        `UPDATE job_sources SET last_error_code = 'UPSTREAM' WHERE id = $1`,
        [s],
      )
      await ledger.resetFailures({ sourceId: s, actor, reason: 'retry' })
      const row = await state(s)
      expect(row.last_error_code).toBe('UPSTREAM')
      expect(Object.keys(row.admin_state_history[0] ?? {}).sort()).toEqual([
        'actor',
        'at',
        'kind',
        'reason',
      ])
    })

    it('a LEGACY (DOU) source is switched on without a manifest entry', async () => {
      const s = await fx.source({
        type: 'DOU_RSS',
        manifestId: null,
        hostKey: null,
        enabled: false,
      })
      expect((await ledger.setEnabled({ sourceId: s, actor, enabled: true })).kind).toBe('SWITCHED')
      expect((await state(s)).enabled).toBe(true)
    })
  })

  describe('enable never resets quota, cooldown, failures or reasons; history is retained', () => {
    it('a disable/enable round trip moves only `enabled` and appends two entries', async () => {
      const s = await kit.reporting({ consecutiveFailures: 2 })
      await session.admin.query(
        `UPDATE job_sources SET cooldown_until = clock_timestamp() + interval '6 hours',
                last_error_code = 'RATE_LIMIT', budget_used = 7,
                admin_state_history = '[{"kind":"SEEDED_EARLIER"}]'::jsonb
          WHERE id = $1`,
        [s],
      )
      const before = await state(s)

      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: false })).toEqual({
        kind: 'SWITCHED',
        changed: true,
        cancelledRuns: 0,
      })
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'SWITCHED',
        changed: true,
        cancelledRuns: 0,
      })

      const after = await state(s)
      expect(after.enabled).toBe(true)
      // Cooldown persists, the counter and the reason stay, the quota is not refilled.
      expect(after.cooldown_ms).toBe(before.cooldown_ms)
      expect(after.next_ms).toBe(before.next_ms)
      expect(after.consecutive_failures).toBe(2)
      expect(after.last_error_code).toBe('RATE_LIMIT')
      expect(after.budget_used).toBe(7)
      // Append-only: the earlier entry is retained, each switch adds one naming the ADMIN.
      expect(after.admin_state_history).toEqual([
        { kind: 'SEEDED_EARLIER' },
        expect.objectContaining({ kind: 'DISABLED', actor }),
        expect.objectContaining({ kind: 'ENABLED', actor }),
      ])
      // Still cooling down, so still not claimable: enable did not override the cooldown.
      expect(await kit.tryClaim(s)).toBeUndefined()
    })

    it('a repeated value is a no-op with no audit entry', async () => {
      const s = await kit.reporting({ enabled: true })
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: true })).toEqual({
        kind: 'SWITCHED',
        changed: false,
        cancelledRuns: 0,
      })
      expect((await state(s)).admin_state_history).toEqual([])
    })
  })

  describe('disable cancels queued work and fences the in-flight owner', () => {
    it('ends the STARTED run CANCELLED; the owner can no longer heartbeat or finish', async () => {
      const s = await kit.reporting()
      const run = await kit.claimOne(s)

      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: false })).toEqual({
        kind: 'SWITCHED',
        changed: true,
        cancelledRuns: 1,
      })

      const [ended] = await fx.runs(s)
      expect([ended?.outcome, ended?.error_code]).toEqual(['CANCELLED', 'CANCELLED'])
      expect(await ledger.heartbeat(handleOf(run))).toBe(false)
      await expect(
        ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null }),
      ).rejects.toBeInstanceOf(RunFencedError)
      // NEUTRAL: no failure counted for the cancel.
      expect((await state(s)).consecutive_failures).toBe(0)
      // Queued work cannot start: neither the scheduled nor the manual claim takes it.
      expect(await kit.tryClaim(s)).toBeUndefined()
      expect(await kit.claimManual(s)).toEqual({ kind: 'REFUSED', reason: 'DISABLED' })
    })

    it('a source without a live run is disabled with nothing cancelled', async () => {
      const s = await kit.reporting()
      expect(await ledger.setEnabled({ sourceId: s, actor, enabled: false })).toEqual({
        kind: 'SWITCHED',
        changed: true,
        cancelledRuns: 0,
      })
      expect(await fx.runs(s)).toEqual([])
    })
  })
})
