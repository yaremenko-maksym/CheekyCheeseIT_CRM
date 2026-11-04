import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { jobSourceHealthEvents } from '../../database/schema'
import { latestHealthTransitions } from './latest-transitions'

/**
 * `latestHealthTransitions` on a capturing query-builder double: the mutation gate runs unit specs
 * only, so the query's shape (distinct key, projection, filters, order) is asserted here as
 * literal SQL and params, not left to the integration specs.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const dialect = new PgDialect()

function capture(rows: { sourceId: string; toState: string | null; reasonCode: string | null }[]) {
  const calls: { distinct?: unknown; projection?: unknown; where?: SQL; orderBy?: unknown[] } = {}
  const db = {
    selectDistinctOn: vi.fn((distinct: unknown, projection: unknown) => {
      calls.distinct = distinct
      calls.projection = projection
      return {
        from: (table: unknown) => {
          expect(table).toBe(jobSourceHealthEvents)
          return {
            where: (where: SQL) => {
              calls.where = where
              return {
                orderBy: async (...order: unknown[]) => {
                  calls.orderBy = order
                  return rows
                },
              }
            },
          }
        },
      }
    }),
  }
  return { db, calls }
}

describe('latestHealthTransitions', () => {
  it('one row per source, the latest TRANSITION of exactly the given sources', async () => {
    const { db, calls } = capture([])
    await latestHealthTransitions(db as never, [A, B])

    expect(calls.distinct).toEqual([jobSourceHealthEvents.sourceId])
    expect(Object.keys(calls.projection as object)).toEqual(['sourceId', 'toState', 'reasonCode'])
    const projection = calls.projection as Record<string, unknown>
    expect(projection['sourceId']).toBe(jobSourceHealthEvents.sourceId)
    expect(projection['toState']).toBe(jobSourceHealthEvents.toState)
    expect(projection['reasonCode']).toBe(jobSourceHealthEvents.reasonCode)

    const where = dialect.sqlToQuery(calls.where!)
    expect(where.sql).toBe(
      '("job_source_health_events"."source_id" in ($1, $2) and "job_source_health_events"."kind" = $3)',
    )
    expect(where.params).toEqual([A, B, 'TRANSITION'])

    const [first, second] = calls.orderBy ?? []
    const order = dialect.sqlToQuery(sql`${first}, ${second}`)
    expect(order.sql).toBe(
      '"job_source_health_events"."source_id", "job_source_health_events"."at" desc',
    )
  })

  it('maps each row to its source; a source without a transition is absent', async () => {
    const { db } = capture([{ sourceId: A, toState: 'FAILING', reasonCode: 'ACCESS_CHANGED' }])
    const map = await latestHealthTransitions(db as never, [A, B])
    expect([...map.entries()]).toEqual([[A, { toState: 'FAILING', reasonCode: 'ACCESS_CHANGED' }]])
    expect(map.has(B)).toBe(false)
  })
})
