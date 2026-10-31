import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DatabaseService } from '../../database/database.service'
import type { NotificationsService } from '../../notifications/notifications.service'
import {
  kyivDate,
  SourceHealthWeeklyReportCron,
  WEEKLY_REPORT_CRON,
} from './source-health-weekly-report.cron'

/**
 * Unit seam: row mapping, recipients and the dedupe key. The SQL aggregates (hand-counted runs,
 * requests, bytes, freshness) are `source-health-weekly-report.integration.spec`.
 */
const NOW = new Date('2026-11-02T07:00:00.000Z') // Monday 09:00 in Kyiv (UTC+2)
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function build(opts: { sources?: unknown[]; admins?: string[]; agg?: unknown[] }) {
  const selects = [opts.sources ?? [], (opts.admins ?? [ADMIN]).map((id) => ({ id }))]
  const db = {
    select: () => ({ from: () => ({ where: async () => selects.shift() }) }),
    execute: vi.fn().mockResolvedValue({ rows: opts.agg ?? [] }),
  }
  const create = vi.fn().mockResolvedValue({ id: 'n' })
  const cron = new SourceHealthWeeklyReportCron(
    { db } as unknown as DatabaseService,
    { create } as unknown as NotificationsService,
  )
  return { cron, create, db }
}

const SOURCES = [
  { id: 's-b', type: 'JOBICY_API', manifestId: null },
  { id: 's-a', type: 'REMOTIVE_API', manifestId: 'remotive_api' },
  { id: 's-new', type: 'REMOTIVE_API', manifestId: 'never_classified' },
]

describe('SourceHealthWeeklyReportCron', () => {
  it('fires Mondays at 09:00 (Kyiv)', () => {
    expect(WEEKLY_REPORT_CRON).toBe('0 9 * * 1')
  })

  it('kyivDate: 23:30 UTC on Sunday is already Monday in Kyiv', () => {
    expect(kyivDate(new Date('2026-11-01T23:30:00.000Z'))).toBe('2026-11-02')
    expect(kyivDate(new Date('2026-11-01T21:30:00.000Z'))).toBe('2026-11-01')
  })

  it('maps bigint strings to numbers, keeps null freshness, skips unclassified, sorts by name', async () => {
    const h = build({
      sources: SOURCES,
      agg: [
        {
          source_id: 's-b',
          runs: '30',
          requests: '30',
          bytes: '12345678901',
          transitions: '1',
          state: 'FAILING',
          p50: null,
          p90: null,
        },
        {
          source_id: 's-a',
          runs: '140',
          requests: '150',
          bytes: '2500000',
          transitions: '0',
          state: 'HEALTHY',
          p50: 12,
          p90: '95',
        },
        {
          source_id: 's-new',
          runs: '0',
          requests: '0',
          bytes: '0',
          transitions: '0',
          state: null,
          p50: null,
          p90: null,
        },
      ],
    })
    await h.cron.run(NOW)
    const data = h.create.mock.calls[0]![0].data
    expect(data.sources).toEqual([
      {
        name: 'JOBICY_API', // no manifest id: the type names the source
        state: 'FAILING',
        transitions: 1,
        runs: 30,
        freshnessP50Min: null,
        freshnessP90Min: null,
        requests: 30,
        bytes: 12_345_678_901,
      },
      {
        name: 'remotive_api',
        state: 'HEALTHY',
        transitions: 0,
        runs: 140,
        freshnessP50Min: 12,
        freshnessP90Min: 95,
        requests: 150,
        bytes: 2_500_000,
      },
    ])
  })

  it('one notification per active admin with the Kyiv week-start dedupe key', async () => {
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const h = build({
      sources: [SOURCES[1]],
      admins: [ADMIN, other],
      agg: [
        {
          source_id: 's-a',
          runs: 1,
          requests: 1,
          bytes: 1,
          transitions: 1,
          state: 'HEALTHY',
          p50: null,
          p90: null,
        },
      ],
    })
    const sent = await h.cron.run(NOW)
    expect(sent).toBe(2)
    expect(h.create.mock.calls.map((c) => c[0])).toEqual(
      [ADMIN, other].map((userId) => ({
        userId,
        type: 'SOURCE_HEALTH_WEEKLY_REPORT',
        title: NOTIFICATION_TITLES.SOURCE_HEALTH_WEEKLY_REPORT,
        data: expect.objectContaining({ weekStart: '2026-10-26' }),
        dedupeKey: 'SOURCE_HEALTH_WEEKLY_REPORT:2026-10-26',
      })),
    )
  })

  it('counts only notifications that were created (a deduped one returns null)', async () => {
    const h = build({
      sources: [SOURCES[1]],
      agg: [
        {
          source_id: 's-a',
          runs: 1,
          requests: 1,
          bytes: 1,
          transitions: 1,
          state: 'HEALTHY',
          p50: null,
          p90: null,
        },
      ],
    })
    h.create.mockResolvedValue(null)
    expect(await h.cron.run(NOW)).toBe(0)
  })

  it('sends nothing when no source has been classified, or there are no sources', async () => {
    const none = build({ sources: [] })
    expect(await none.cron.run(NOW)).toBe(0)
    expect(none.create).not.toHaveBeenCalled()

    const unclassified = build({
      sources: [SOURCES[2]],
      agg: [
        {
          source_id: 's-new',
          runs: 0,
          requests: 0,
          bytes: 0,
          transitions: 0,
          state: null,
          p50: null,
          p90: null,
        },
      ],
    })
    expect(await unclassified.cron.run(NOW)).toBe(0)
    expect(unclassified.create).not.toHaveBeenCalled()
  })

  it('the handler never rethrows (an unhandled rejection would silence every other cron)', async () => {
    const h = build({ sources: SOURCES })
    h.db.execute.mockRejectedValue(new Error('db down'))
    await expect(h.cron.handleWeeklyReport()).resolves.toBeUndefined()
  })
})
