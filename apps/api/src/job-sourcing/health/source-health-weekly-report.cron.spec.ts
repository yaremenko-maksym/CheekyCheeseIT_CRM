import { PgDialect } from 'drizzle-orm/pg-core'
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DatabaseService } from '../../database/database.service'
import type { NotificationsService } from '../../notifications/notifications.service'
import { REPORTING_TYPES } from './reporting-types'
import {
  kyivDate,
  SourceHealthWeeklyReportCron,
  toWeeklyRows,
  WEEKLY_REPORT_CRON,
  weeklyAggregateSql,
  weeklyWindow,
  type AggRow,
} from './source-health-weekly-report.cron'

/**
 * Unit seam: window, row mapping, recipients, dedupe key, and the pinned statement. The SQL
 * figures (hand-counted runs, requests, bytes, freshness) are
 * `source-health-weekly-report.integration.spec`, against a real Postgres.
 */
const NOW = new Date('2026-11-02T07:00:00.000Z') // Monday 09:00 in Kyiv (UTC+2)
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function agg(over: Partial<AggRow> = {}): AggRow {
  return {
    name: 'remotive_api',
    state: 'HEALTHY',
    transitions: 0,
    runs: 1,
    requests: 1,
    bytes: 1,
    p50: null,
    p90: null,
    ...over,
  }
}

function build(opts: { agg?: AggRow[]; admins?: string[] } = {}) {
  const admins = (opts.admins ?? [ADMIN]).map((id) => ({ id }))
  const execute = vi.fn().mockResolvedValue({ rows: opts.agg ?? [agg()] })
  const db = { select: () => ({ from: () => ({ where: async () => admins }) }), execute }
  const create = vi.fn().mockResolvedValue({ id: 'n' })
  const cron = new SourceHealthWeeklyReportCron(
    { db } as unknown as DatabaseService,
    { create } as unknown as NotificationsService,
  )
  return { cron, create, execute }
}

afterEach(() => vi.restoreAllMocks())

describe('schedule and window', () => {
  it('fires Mondays at 09:00 (Kyiv)', () => {
    expect(WEEKLY_REPORT_CRON).toBe('0 9 * * 1')
  })

  it('kyivDate: 23:30 UTC on Sunday is already Monday in Kyiv', () => {
    expect(kyivDate(new Date('2026-11-01T23:30:00.000Z'))).toBe('2026-11-02')
    expect(kyivDate(new Date('2026-11-01T21:30:00.000Z'))).toBe('2026-11-01')
  })

  it('weeklyWindow: seven days back from now, labelled with the Kyiv date it began on', () => {
    expect(weeklyWindow(NOW)).toEqual({
      from: new Date('2026-10-26T07:00:00.000Z'),
      weekStart: '2026-10-26',
    })
  })
})

describe('toWeeklyRows', () => {
  it('maps bigint strings to numbers and keeps null freshness as null', () => {
    const rows = toWeeklyRows([
      agg({
        name: 'a',
        state: 'FAILING',
        transitions: '1',
        runs: '30',
        requests: '31',
        bytes: '12345678901',
        p50: null,
        p90: null,
      }),
      agg({ name: 'b', p50: 12, p90: '95' }),
    ])
    expect(rows).toEqual([
      {
        name: 'a',
        state: 'FAILING',
        transitions: 1,
        runs: 30,
        freshnessP50Min: null,
        freshnessP90Min: null,
        requests: 31,
        bytes: 12_345_678_901,
      },
      {
        name: 'b',
        state: 'HEALTHY',
        transitions: 0,
        runs: 1,
        freshnessP50Min: 12,
        freshnessP90Min: 95,
        requests: 1,
        bytes: 1,
      },
    ])
  })

  it('leaves out a source that has never been classified, and sorts by name', () => {
    const rows = toWeeklyRows([
      agg({ name: 'zeta' }),
      agg({ name: 'never_classified', state: null }),
      agg({ name: 'alpha' }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('weeklyAggregateSql', () => {
  it('reads the reporting types over [from, now) and pins the clauses that make the figures', () => {
    const from = new Date('2026-10-26T07:00:00.000Z')
    const q = new PgDialect().sqlToQuery(weeklyAggregateSql(from, NOW))
    expect(q.params).toEqual([...REPORTING_TYPES, from, NOW, from, NOW, from, NOW])
    const placeholders = REPORTING_TYPES.map((_, i) => `$${i + 1}`).join(', ')
    for (const fragment of [
      `FROM job_sources WHERE type IN (${placeholders})`,
      'FROM job_collection_runs',
      'started_at >= ',
      'sum(request_count)',
      'sum(bytes_read)',
      "kind = 'TRANSITION'",
      'DISTINCT ON (source_id)',
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY m)',
      'percentile_cont(0.9) WITHIN GROUP (ORDER BY m)',
      'ORDER BY v.received_seq ASC LIMIT 1',
      'first_rev.published_at IS NOT NULL',
      'min(ended_at)',
    ]) {
      expect(q.sql, fragment).toContain(fragment)
    }
  })
})

describe('SourceHealthWeeklyReportCron.run', () => {
  it('one notification per active admin, with the Kyiv week-start dedupe key and the mapped rows', async () => {
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const h = build({ admins: [ADMIN, other] })
    expect(await h.cron.run(NOW)).toBe(2)
    expect(h.create.mock.calls.map((c) => c[0])).toEqual(
      [ADMIN, other].map((userId) => ({
        userId,
        type: 'SOURCE_HEALTH_WEEKLY_REPORT',
        title: NOTIFICATION_TITLES.SOURCE_HEALTH_WEEKLY_REPORT,
        data: { weekStart: '2026-10-26', sources: toWeeklyRows([agg()]) },
        dedupeKey: 'SOURCE_HEALTH_WEEKLY_REPORT:2026-10-26',
      })),
    )
  })

  it('counts only notifications that were created (a deduped one returns null)', async () => {
    const h = build()
    h.create.mockResolvedValue(null)
    expect(await h.cron.run(NOW)).toBe(0)
  })

  it('sends nothing when no source has been classified', async () => {
    const h = build({ agg: [agg({ state: null })] })
    expect(await h.cron.run(NOW)).toBe(0)
    expect(h.create).not.toHaveBeenCalled()
  })
})

describe('SourceHealthWeeklyReportCron.handleWeeklyReport', () => {
  it('runs the report for the current time and logs how many were sent', async () => {
    const h = build()
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    vi.useFakeTimers({ now: NOW })
    try {
      await h.cron.handleWeeklyReport()
    } finally {
      vi.useRealTimers()
    }
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('source health weekly report: 1 notification(s)')
  })

  it('never rethrows, and logs the failure (an unhandled rejection would silence every cron)', async () => {
    const h = build()
    h.execute.mockRejectedValue(new Error('db down'))
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expect(h.cron.handleWeeklyReport()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toContain('source health weekly report failed')
  })
})
