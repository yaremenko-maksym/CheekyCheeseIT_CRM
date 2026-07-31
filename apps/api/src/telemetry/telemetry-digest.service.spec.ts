import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { TELEMETRY_ERRORS_DIGEST_LIMIT, TelemetryDigestService } from './telemetry-digest.service'

/**
 * Unit tests for the ORCHESTRATION around the digest (does it call
 * fetchAndNotifyNewErrors / getUxAggregates correctly, does `includeUx`
 * gate the `ux` key). The UX aggregate SQL itself (percentile_cont,
 * FILTER-clause grouping) can only be proven against a real Postgres — see
 * `telemetry.integration.spec.ts` (AC5).
 */

/**
 * A `.select()` mock shared by THREE distinct query shapes used in this
 * file (security round 1 HIGH-2 added a 4th chain — the csp_reports COUNT
 * query — on top of the pre-existing errors/csp-rows ones):
 *   - errors:            select().from().where().orderBy()            [awaited directly]
 *   - csp violation rows: select().from().where().orderBy().limit(n)  [.limit() chained]
 *   - csp violation count: select({count}).from().where()             [awaited directly]
 * Discriminated by whether `fields` (the `.select()` argument) contains a
 * `count` key — mirrors the pattern already used in
 * `telemetry-retention.cron.spec.ts`'s `makeCapDb`.
 */
function makeEmptyDb(): DatabaseService {
  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: () => {
          if (fields && 'count' in fields) {
            return { where: async () => [{ count: 0 }] }
          }
          return {
            where: () => ({
              orderBy: () => {
                const rows: unknown[] = []
                const result = Promise.resolve(rows) as Promise<unknown[]> & {
                  limit: (n: number) => Promise<unknown[]>
                }
                result.limit = async () => rows
                return result
              },
            }),
          }
        },
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

  it('ALWAYS includes cspViolations + cspViolationsTotal, even when includeUx=false (task-csp-reports-and-flip §4)', async () => {
    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })
    expect(result).toHaveProperty('cspViolations')
    expect(result.cspViolations).toEqual([])
    expect(result.cspViolationsTotal).toBe(0)
  })

  it('sources cspViolations/cspViolationsTotal from getCspViolations', async () => {
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
    vi.spyOn(svc, 'getCspViolations').mockResolvedValue({
      items: [stubViolation],
      totalMatching: 42,
    })

    const result = await svc.getDigest({ since: new Date('2026-01-01'), includeUx: false })

    expect(result.cspViolations).toEqual([stubViolation])
    expect(result.cspViolationsTotal).toBe(42)
  })
})

describe('TelemetryDigestService.getCspViolations', () => {
  it('maps DB rows to the wire shape, ordered/limited at the query level (not asserted here), and returns totalMatching separately', async () => {
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
        select: (fields?: Record<string, unknown>) => ({
          from: () => {
            if (fields && 'count' in fields) {
              return { where: async () => [{ count: 7 }] }
            }
            return {
              where: () => ({
                orderBy: () => ({
                  limit: async () => [row],
                }),
              }),
            }
          },
        }),
      },
    } as unknown as DatabaseService
    const svc = new TelemetryDigestService(db)

    const result = await svc.getCspViolations(new Date('2026-07-01T00:00:00Z'))

    expect(result.totalMatching).toBe(7)
    expect(result.items).toEqual([
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

  it('returns an empty items array and totalMatching=0 when there are no matching rows', async () => {
    const svc = new TelemetryDigestService(makeEmptyDb())
    const result = await svc.getCspViolations(new Date('2026-01-01'))
    expect(result.items).toEqual([])
    expect(result.totalMatching).toBe(0)
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
              orderBy: () => ({
                limit: async () => [],
              }),
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
              orderBy: () => ({
                limit: async () => [row],
              }),
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

  // task-telemetry-caps AC3 — the select is bounded, not just "unlikely to be large".
  it('AC3: applies an explicit `.limit(TELEMETRY_ERRORS_DIGEST_LIMIT)` — never an unbounded select', async () => {
    let limitArg: number | undefined
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async (n: number) => {
                  limitArg = n
                  return []
                },
              }),
            }),
          }),
        }),
      },
    } as unknown as DatabaseService
    const svc = new TelemetryDigestService(db)

    await svc.fetchAndNotifyNewErrors(new Date('2026-01-01'))

    expect(limitArg).toBe(TELEMETRY_ERRORS_DIGEST_LIMIT)
  })
})
