import { randomUUID } from 'node:crypto'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { ExcludedJobSourceDto, SessionUser } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, LedgerKit, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { recordHostBan } from '../scheduling/host-state'
import { nextSlot } from '../scheduling/next-slot'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * r5 Task 2.5 T9 — the ADMIN reset and the excluded-sources listing against a REAL Postgres, AS
 * `crm_app` (the service runs on the `crm_app` pool; fixtures go through the migration role).
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-source-admin.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOUR = 3_600_000

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let service: JobSourceAdminService
let admin: SessionUser

const as = (role: SessionUser['role']): SessionUser => ({ ...admin, role })
const NON_ADMIN: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

async function listed(id: string): Promise<ExcludedJobSourceDto | undefined> {
  return (await service.listExcluded(admin)).find((i) => i.sourceId === id)
}

async function dbNow(): Promise<number> {
  const { rows } = await session.admin.query('SELECT clock_timestamp() AS t')
  return (rows[0].t as Date).getTime()
}

describe.skipIf(!hasDatabaseUrl())('T9 ADMIN reset + excluded listing, as crm_app', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    const registry = specRegistry(['REMOTIVE_API', 'JSEARCH_API'])
    ledger = new JobRunLedger(drizzle(session.pool, { schema }), registry, catalog)
    // T7: the service runs on THE ledger (here the spec's, over the spec catalog).
    service = new JobSourceAdminService(session.databaseService, ledger)
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T9 spec', 'ADMIN') RETURNING id`,
      [`t9spec-${TAG}@example.test`],
    )
    admin = {
      id: rows[0].id as string,
      email: `t9spec-${TAG}@example.test`,
      displayName: 'T9 spec',
      avatarUrl: null,
      role: 'ADMIN',
      seniorSharePercent: 0,
      legalFullName: null,
    }
    kit = new LedgerKit(ledger, fx, catalog, admin.id)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [admin.id])
    } finally {
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  describe('AC 2: reset', () => {
    it('makes a capped source claimable and writes exactly one RESET_FAILURES entry on the DB clock', async () => {
      const s = await kit.reporting({
        consecutiveFailures: 3,
        nextAttemptSql: "clock_timestamp() + interval '24 hours'",
      })
      await session.admin.query(
        `UPDATE job_sources SET cooldown_until = clock_timestamp() + interval '4 hours' WHERE id = $1`,
        [s],
      )
      expect(await kit.tryClaim(s)).toBeUndefined()

      const before = await dbNow()
      await service.resetFailures(s, { reason: 'provider fixed' }, admin)
      const after = await dbNow()

      const history = (await fx.sourceRow(s)).admin_state_history as {
        kind: string
        actor: string
        at: string
        reason: string
      }[]
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        kind: 'RESET_FAILURES',
        actor: admin.id,
        reason: 'provider fixed',
      })
      const at = Date.parse(history[0]?.at ?? '')
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(after)
      expect((await kit.claimOne(s)).sourceId).toBe(s)
    })

    it('accepts an upper-case UUID and resets the same row', async () => {
      const s = await kit.reporting({ consecutiveFailures: 3 })
      await service.resetFailures(s.toUpperCase(), { reason: 'case' }, admin)
      expect((await fx.sourceRow(s)).consecutive_failures).toBe(0)
    })

    it('answers 404 for an unknown source', async () => {
      await expect(service.resetFailures(randomUUID(), { reason: 'x' }, admin)).rejects.toThrow(
        NotFoundException,
      )
    })

    it.each(NON_ADMIN)('refuses %s in the service body and writes nothing', async (role) => {
      const s = await kit.reporting({ consecutiveFailures: 3 })
      await expect(service.resetFailures(s, { reason: 'nope' }, as(role))).rejects.toThrow(
        ForbiddenException,
      )
      const row = await fx.sourceRow(s)
      expect([row.consecutive_failures, row.admin_state_history]).toEqual([3, []])
    })
  })

  describe('listing', () => {
    it.each(NON_ADMIN)('refuses %s in the service body', async (role) => {
      await expect(service.listExcluded(as(role))).rejects.toThrow(ForbiddenException)
    })

    it('AC 4: lists a capped source and a source on a paused host, with the pause', async () => {
      const capped = await kit.reporting({ consecutiveFailures: 3 })
      await session.admin.query(
        `UPDATE job_sources SET last_error_code = 'PARSE_DRIFT' WHERE id = $1`,
        [capped],
      )
      const host = fx.host('paused')
      const paused = await kit.reporting({ hostKey: host })
      await recordHostBan(drizzle(session.admin, { schema }), {
        hostKey: host,
        reason: 'HTTP_429',
        sourceId: paused,
        floorHours: 0,
      })

      expect(await listed(capped)).toMatchObject({
        reasons: ['FAILURE_CAP'],
        consecutiveFailures: 3,
        lastErrorCode: 'PARSE_DRIFT',
      })
      const p = await listed(paused)
      expect(p).toMatchObject({
        reasons: ['HOST_PAUSED'],
        hostKey: host,
        pauseReason: 'HTTP_429',
        pauseSourceId: paused,
      })
      expect(Date.parse(p?.pausedUntil ?? '')).toBeGreaterThan(await dbNow())
    })

    it('AC 5 (SR-L-18): a source capped by 3 LEASE_EXPIRED endings is listed with its reason', async () => {
      const s = await kit.reporting()
      for (let i = 0; i < 3; i += 1) {
        const run = await kit.claimOne(s)
        await ageRun(session.admin, run.runId, 10 * 60_000)
        expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
        await ageSource(session.admin, s, 48 * HOUR)
      }
      expect(await listed(s)).toMatchObject({
        consecutiveFailures: 3,
        lastErrorCode: 'LEASE_EXPIRED',
      })
      expect((await listed(s))?.reasons).toContain('FAILURE_CAP')
    })

    it('AC 6 (SR-L-24): a source due for more than 2 of its slots is listed; one under 2 is not', async () => {
      // U1b: an hourly grid. Due 3 h ago: slot 1 is within the following hour, slot 2 an hour after
      // that, both past. Due 30 min ago: slot 2 is at least 30 min ahead. `min_interval_hours` (here a
      // misleading 1000) is not read.
      const hourly = {
        fetchProfile: { intervalMinutes: 60, offIntervalMinutes: null, window: null },
      }
      const starved = await kit.reporting(
        { minIntervalHours: 1000, nextAttemptSql: "clock_timestamp() - interval '3 hours'" },
        hourly,
      )
      const late = await kit.reporting(
        { minIntervalHours: 1, nextAttemptSql: "clock_timestamp() - interval '30 minutes'" },
        hourly,
      )
      const unscheduled = await kit.reporting(
        { nextAttemptSql: "clock_timestamp() - interval '400 hours'" },
        { fetchProfile: null },
      )
      expect((await listed(starved))?.reasons).toEqual(['OVERDUE'])
      expect(await listed(late)).toBeUndefined()
      // A null profile (owner, Q8) has no next slot, so it is never overdue.
      expect(await listed(unscheduled)).toBeUndefined()
    })

    it('U1b AC 6: the listing`s next-due is the ledger`s next slot for the row it finished', async () => {
      const berlin = {
        intervalMinutes: 60,
        offIntervalMinutes: 180,
        window: {
          timeZone: 'Europe/Berlin',
          days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as ('MON' | 'TUE' | 'WED' | 'THU' | 'FRI')[],
          from: '08:00',
          to: '19:00',
        },
      }
      // Two failures already: this failure caps it, so the listing shows it (FAILURE_CAP).
      const s = await kit.reporting({ consecutiveFailures: 2 }, { fetchProfile: berlin })
      const run = await kit.claimOne(s)
      await ledger.finish(run, { outcome: 'FAILED', errorCode: 'UPSTREAM' })
      const { rows } = await session.admin.query(
        `SELECT r.ended_at, s.manifest_id FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
          WHERE r.id = $1`,
        [run.runId],
      )
      // U2: an UPSTREAM ending raises the slow-down level 0 -> 1, and the slot follows it.
      const expected = nextSlot(rows[0].ended_at as Date, berlin, {
        floorMinutes: 0,
        slowdownLevel: 1,
        staggerKey: rows[0].manifest_id as string,
      })
      expect(await listed(s)).toMatchObject({
        reasons: ['FAILURE_CAP'],
        nextAttemptAt: expected.toISOString(),
      })
    })

    it('an overdue source that is disabled or paused by an admin is not starved, so not listed', async () => {
      const off = await kit.reporting({
        enabled: false,
        nextAttemptSql: "clock_timestamp() - interval '72 hours'",
      })
      const parked = await kit.reporting({
        adminState: 'PAUSED',
        nextAttemptSql: "clock_timestamp() - interval '72 hours'",
      })
      expect(await listed(off)).toBeUndefined()
      expect(await listed(parked)).toBeUndefined()
    })

    it('lists a source whose last claim was refused, with the refusal; not a run failure code', async () => {
      const refused = await kit.reporting()
      const failed = await kit.reporting({ consecutiveFailures: 1 })
      await session.admin.query(
        `UPDATE job_sources SET last_error_code = CASE WHEN id = $1 THEN 'TRANSPORT_NOT_WIRED' ELSE 'PARSE_DRIFT' END
          WHERE id = ANY($2::uuid[])`,
        [refused, [refused, failed]],
      )
      expect(await listed(refused)).toMatchObject({
        reasons: ['CLAIM_REFUSED'],
        lastErrorCode: 'TRANSPORT_NOT_WIRED',
      })
      expect(await listed(failed)).toBeUndefined()
    })

    it('does not list a healthy source', async () => {
      expect(await listed(await kit.reporting())).toBeUndefined()
    })
  })
})
