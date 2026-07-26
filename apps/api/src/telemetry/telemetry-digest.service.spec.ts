import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { TelemetryDigestService } from './telemetry-digest.service'

/**
 * Unit tests for the ORCHESTRATION around the digest (does it call
 * fetchAndNotifyNewErrors / getUxAggregates correctly, does `includeUx`
 * gate the `ux` key). The UX aggregate SQL itself (percentile_cont,
 * FILTER-clause grouping) can only be proven against a real Postgres — see
 * `telemetry.integration.spec.ts` (AC5).
 */

function makeEmptyDb(): DatabaseService {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [],
          }),
        }),
      }),
    },
  } as unknown as DatabaseService
}

describe('TelemetryDigestService.getDigest — orchestration', () => {
  let svc: TelemetryDigestService

  beforeEach(() => {
    svc = new TelemetryDigestService(makeEmptyDb())
  })

  it('omits the `ux` key entirely when includeUx=false', async () => {
    const spy = vi.spyOn(svc, 'getUxAggregates')
    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })

    expect(result).toHaveProperty('errors')
    expect(result).not.toHaveProperty('ux')
    expect(spy).not.toHaveBeenCalled()
  })

  it('computes and includes `ux` when includeUx=true', async () => {
    const stubUx = {
      topRoutesByRole: [],
      featureClicks: [],
      formAbandonRates: [],
      medianDurations: [],
    }
    vi.spyOn(svc, 'getUxAggregates').mockResolvedValue(stubUx)

    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: true })

    expect(result.ux).toEqual(stubUx)
  })

  it('returns an empty errors array when there are no NEW errors', async () => {
    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })
    expect(result.errors).toEqual([])
  })

  it('ALWAYS includes cspViolations, even when includeUx=false (task-csp-reports-and-flip §4)', async () => {
    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })
    expect(result).toHaveProperty('cspViolations')
    expect(result.cspViolations).toEqual([])
  })

  it('sources cspViolations from getCspViolations', async () => {
    const stubViolation = {
      id: '11111111-1111-4111-8111-111111111111',
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example',
      documentPath: '/team',
      disposition: 'report' as const,
      userAgent: null,
      count: 3,
      firstSeen: '2026-07-01T00:00:00.000Z',
      lastSeen: '2026-07-02T00:00:00.000Z',
    }
    vi.spyOn(svc, 'getCspViolations').mockResolvedValue([stubViolation])

    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })

    expect(result.cspViolations).toEqual([stubViolation])
  })
})

describe('TelemetryDigestService.getCspViolations', () => {
  it('maps DB rows to the wire shape, ordered by count desc (query-level, not asserted here)', async () => {
    const row = {
      id: '22222222-2222-4222-8222-222222222222',
      effectiveDirective: 'style-src',
      blockedUri: 'https://cdn.example/x.css',
      documentPath: '/finance',
      disposition: 'enforce' as const,
      userAgent: 'Mozilla/5.0',
      count: 5,
      firstSeen: new Date('2026-07-01T00:00:00Z'),
      lastSeen: new Date('2026-07-03T00:00:00Z'),
    }
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => [row],
            }),
          }),
        }),
      },
    } as unknown as DatabaseService
    const svc = new TelemetryDigestService(db)

    const result = await svc.getCspViolations(new Date('2026-07-01T00:00:00Z'))

    expect(result).toEqual([
      {
        id: row.id,
        effectiveDirective: 'style-src',
        blockedUri: 'https://cdn.example/x.css',
        documentPath: '/finance',
        disposition: 'enforce',
        userAgent: 'Mozilla/5.0',
        count: 5,
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-03T00:00:00.000Z',
      },
    ])
  })

  it('returns an empty array when there are no matching rows', async () => {
    const svc = new TelemetryDigestService(makeEmptyDb())
    const result = await svc.getCspViolations(new Date('2026-01-01'))
    expect(result).toEqual([])
  })
})

describe('TelemetryDigestService.fetchAndNotifyNewErrors', () => {
  it('does NOT issue an UPDATE when there are no matching rows', async () => {
    let updateCalled = false
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => [],
            }),
          }),
        }),
        update: () => {
          updateCalled = true
          return { set: () => ({ where: async () => undefined }) }
        },
      },
    } as unknown as DatabaseService
    const svc = new TelemetryDigestService(db)

    const result = await svc.fetchAndNotifyNewErrors(new Date('2026-01-01'))

    expect(result).toEqual([])
    expect(updateCalled).toBe(false)
  })

  it('maps DB rows to the wire shape and marks them NOTIFIED', async () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fp-1',
      source: 'API' as const,
      message: 'boom',
      stack: null,
      route: '/finance',
      userId: null,
      userRole: null,
      meta: {},
      count: 3,
      firstSeen: new Date('2026-07-01T00:00:00Z'),
      lastSeen: new Date('2026-07-02T00:00:00Z'),
      status: 'NEW' as const,
      githubIssueNumber: null,
    }

    let updateWhereArg: unknown
    let updateSetArg: unknown
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => [row],
            }),
          }),
        }),
        update: () => ({
          set: (setArg: unknown) => {
            updateSetArg = setArg
            return {
              where: async (whereArg: unknown) => {
                updateWhereArg = whereArg
                return undefined
              },
            }
          },
        }),
      },
    } as unknown as DatabaseService
    const svc = new TelemetryDigestService(db)

    const result = await svc.fetchAndNotifyNewErrors(new Date('2026-07-01T00:00:00Z'))

    expect(result).toEqual([
      {
        id: row.id,
        fingerprint: 'fp-1',
        source: 'API',
        message: 'boom',
        stack: null,
        route: '/finance',
        userId: null,
        userRole: null,
        meta: {},
        count: 3,
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-02T00:00:00.000Z',
        status: 'NEW',
        githubIssueNumber: null,
      },
    ])
    expect(updateSetArg).toMatchObject({ status: 'NOTIFIED' })
    expect(updateWhereArg).toBeDefined()
  })
})
