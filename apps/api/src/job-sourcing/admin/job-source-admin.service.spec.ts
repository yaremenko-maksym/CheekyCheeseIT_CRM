import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import type { MeterDb } from '../metering/account-meter.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * Unit doubles for the T9 service, so the mutation gate can see the role check, the row mapping
 * and the reset call (it never runs `*.integration.spec.ts`). The SQL itself is verified against
 * real Postgres, as crm_app, by job-source-admin.integration.spec.ts.
 */

const ADMIN: SessionUser = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  email: 'admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const NON_ADMIN: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const dialect = new PgDialect()

function harness(rows: Record<string, unknown>[] = [], resetRows: unknown[] = [{ ok: 1 }]) {
  const execute = vi.fn(async (_q: SQL) => ({ rows }))
  const txExecute = vi.fn(async (_q: SQL) => ({ rows: resetRows }))
  const transaction = vi.fn(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
    cb({ execute: txExecute }),
  )
  const database = { db: { execute, transaction } } as unknown as DatabaseService
  // T7: the service runs on THE ledger; its catalog gives the provider floor OVERDUE applies.
  const catalog = new SpecCatalog()
  catalog.add('remotive.api.software-dev', {
    floorHours: 60,
    fetchProfile: {
      intervalMinutes: 1440,
      offIntervalMinutes: null,
      window: null,
      fixedSlots: { timeZone: 'UTC', times: ['00:00'] },
    },
  })
  catalog.add('unscheduled.entry', { fetchProfile: null })
  catalog.add('hourly.entry', {
    floorHours: 0,
    fetchProfile: { intervalMinutes: 60, offIntervalMinutes: null, window: null },
  })
  const ledger = new JobRunLedger(database.db as unknown as MeterDb, specRegistry([]), catalog)
  return {
    service: new JobSourceAdminService(database, ledger),
    execute,
    txExecute,
  }
}

const HOUR = 3_600_000
const NEXT = Date.parse('2026-10-20T00:00:00.000Z')

const row = (over: Record<string, unknown> = {}) => ({
  id: SOURCE,
  type: 'REMOTIVE_API',
  host_key: 'remotive.com',
  consecutive_failures: 3,
  last_error_code: 'LEASE_EXPIRED',
  manifest_id: null,
  min_interval_hours: 24,
  slowdown_level: 0,
  now_ms: NEXT + 5 * 24 * HOUR,
  next_attempt_ms: NEXT,
  paused_until_ms: null,
  pause_reason: null,
  pause_source_id: null,
  capped: false,
  host_paused: false,
  refused: false,
  overdue: false,
  ...over,
})

describe('JobSourceAdminService — role check in the service body', () => {
  it.each(NON_ADMIN)('%s is refused on both methods, before any query', async (role) => {
    const h = harness()
    const user = { ...ADMIN, role }
    await expect(h.service.listExcluded(user)).rejects.toThrow(
      new ForbiddenException('Job source controls are ADMIN only'),
    )
    await expect(h.service.resetFailures(SOURCE, { reason: 'x' }, user)).rejects.toThrow(
      new ForbiddenException('Job source controls are ADMIN only'),
    )
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.txExecute).not.toHaveBeenCalled()
  })
})

describe('listExcluded — the row mapping', () => {
  it('maps every flag to its reason, in a fixed order', async () => {
    const h = harness([row({ capped: true, host_paused: true, refused: true, overdue: true })])
    const [item] = await h.service.listExcluded(ADMIN)
    expect(item?.reasons).toEqual(['FAILURE_CAP', 'HOST_PAUSED', 'CLAIM_REFUSED', 'OVERDUE'])
  })

  it.each([
    ['capped', 'FAILURE_CAP'],
    ['host_paused', 'HOST_PAUSED'],
    ['refused', 'CLAIM_REFUSED'],
    ['overdue', 'OVERDUE'],
  ])('%s alone gives %s; a non-boolean truthy flag gives nothing', async (flag, reason) => {
    const h = harness([row({ [flag]: true }), row({ [flag]: 't' })])
    // a row left with no reason is not excluded, so it is not listed (T7)
    expect((await h.service.listExcluded(ADMIN)).map((r) => r.reasons)).toEqual([[reason]])
  })

  it('OVERDUE is two of the ledger`s own slots past due, at the provider floor (T9 CR-M-2, U1b)', async () => {
    // Due 2026-10-20 00:00 UTC; one slot a day at 00:00 UTC, floor 60 h. Slot 1: the first 00:00
    // after 10-22 12:00 = 10-23 00:00 (+72 h). Slot 2: the first 00:00 after 10-25 12:00 =
    // 10-26 00:00 (+144 h). Overdue only past +144 h.
    const at = (hours: number) =>
      row({ overdue: true, manifest_id: 'remotive.api.software-dev', now_ms: NEXT + hours * HOUR })
    const h = harness([at(143), at(144), at(145)])
    const out = await h.service.listExcluded(ADMIN)
    expect(out.map((r) => r.reasons)).toEqual([['OVERDUE']])
  })

  it('U2: OVERDUE reads the source`s slow-down level, as the ledger`s own slots do', async () => {
    // Hourly grid, no floor. At level 0 the two slots after NEXT fall within NEXT + 2 h, so
    // NEXT + 4 h is overdue. At level 2 each slot is more than 3 h (60 x (2^2 - 1)) after the
    // previous one, so the second falls past NEXT + 6 h: NEXT + 4 h is not overdue.
    const at = (level: number) =>
      row({
        overdue: true,
        manifest_id: 'hourly.entry',
        slowdown_level: level,
        now_ms: NEXT + 4 * HOUR,
      })
    const h = harness([at(0), at(2)])
    const out = await h.service.listExcluded(ADMIN)
    expect(out.map((r) => r.reasons)).toEqual([['OVERDUE']])
  })

  it('without a catalog entry the ledger`s daily fallback applies; min_interval_hours is not read', async () => {
    const h = harness([
      row({ overdue: true, now_ms: NEXT + 48 * HOUR }), // exactly two cadences: not yet
      row({ overdue: true, now_ms: NEXT + 47 * HOUR }),
      row({ overdue: true, now_ms: NEXT + 49 * HOUR }),
      row({ overdue: true, min_interval_hours: 1, now_ms: NEXT + 21 * HOUR }),
      row({ overdue: true, manifest_id: 'no.such.entry', now_ms: NEXT + 49 * HOUR }),
    ])
    expect((await h.service.listExcluded(ADMIN)).length).toBe(2)
  })

  it('a null-profile source (owner, Q8) is never overdue: it has no next slot', async () => {
    const h = harness([
      row({ overdue: true, manifest_id: 'unscheduled.entry', now_ms: NEXT + 1000 * HOUR }),
    ])
    expect(await h.service.listExcluded(ADMIN)).toEqual([])
  })

  it('projects the allow-listed columns, instants as ISO strings', async () => {
    const paused = Date.parse('2026-10-26T12:00:00.000Z')
    const h = harness([
      row({
        capped: true,
        paused_until_ms: paused,
        pause_reason: 'HTTP_429',
        pause_source_id: SOURCE,
        config: { apiKey: 'never' },
      }),
    ])
    expect(await h.service.listExcluded(ADMIN)).toEqual([
      {
        sourceId: SOURCE,
        type: 'REMOTIVE_API',
        hostKey: 'remotive.com',
        reasons: ['FAILURE_CAP'],
        consecutiveFailures: 3,
        lastErrorCode: 'LEASE_EXPIRED',
        nextAttemptAt: '2026-10-20T00:00:00.000Z',
        pausedUntil: '2026-10-26T12:00:00.000Z',
        pauseReason: 'HTTP_429',
        pauseSourceId: SOURCE,
      },
    ])
  })

  it('maps NULL columns to null, and a non-number instant to null', async () => {
    const h = harness([
      row({
        host_key: null,
        last_error_code: null,
        next_attempt_ms: null,
        paused_until_ms: '2026-10-26',
        overdue: true,
      }),
    ])
    expect(await h.service.listExcluded(ADMIN)).toEqual([
      expect.objectContaining({
        hostKey: null,
        lastErrorCode: null,
        nextAttemptAt: null,
        pausedUntil: null,
        pauseReason: null,
        pauseSourceId: null,
      }),
    ])
  })

  it('passes the failure cap and the claim refusal codes to the query', async () => {
    const h = harness([])
    await h.service.listExcluded(ADMIN)
    const q = h.execute.mock.calls[0]?.[0]
    const { params } = dialect.sqlToQuery(q as SQL)
    // U1b: no cadence parameter any more (the 24 h fallback of `min_interval_hours` is gone).
    expect(params).not.toContain(24)
    expect(params).toEqual(
      expect.arrayContaining([
        3,
        '{MANIFEST_ENTRY_MISSING,NOT_ACTIVATABLE,READINESS_BLOCKED,TRANSPORT_NOT_WIRED,METER_MISSING,HOST_KEY_MISSING,HOST_PAUSED,HOST_BUSY,HOST_RATE_GAP,HOST_DAILY_CAP,HOST_REQUEST_BUDGET,NOT_SCHEDULED}',
      ]),
    )
  })
})

describe('resetFailures — calls the ledger', () => {
  it('passes the lower-cased id, the actor and the reason', async () => {
    const h = harness()
    await h.service.resetFailures(SOURCE.toUpperCase(), { reason: 'provider fixed' }, ADMIN)
    const { sql, params } = dialect.sqlToQuery(h.txExecute.mock.calls[0]?.[0] as SQL)
    expect(sql).toContain('RESET_FAILURES')
    expect(params).toEqual(expect.arrayContaining([ADMIN.id, 'provider fixed', SOURCE]))
  })

  it('answers NotFound when no row was updated', async () => {
    const h = harness([], [])
    await expect(h.service.resetFailures(SOURCE, { reason: 'x' }, ADMIN)).rejects.toThrow(
      new NotFoundException('Job source not found'),
    )
  })
})
