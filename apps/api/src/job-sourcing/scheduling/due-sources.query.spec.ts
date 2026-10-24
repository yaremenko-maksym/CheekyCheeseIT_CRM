import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { jobSources } from '../../database/schema'
import { MAX_CONSECUTIVE_FAILURES } from './due-policy'
import type { SQL } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { dueSourcesPredicate, findDueSources } from './due-sources.query'
import { hostOpenPredicate } from './host-state'

/**
 * Renders the predicate to text and parameters. The SEMANTICS are proven against a real Postgres by
 * `due-sources.query.integration.spec.ts` (which Stryker cannot reach); this pins the shape, so a
 * dropped term, a flipped comparison or a lost cadence term is visible without a database.
 */
const render = (...args: Parameters<typeof dueSourcesPredicate>) =>
  new PgDialect().sqlToQuery(dueSourcesPredicate(...args))

describe('dueSourcesPredicate (rendered)', () => {
  it('a scheduled predicate carries every scalar term, on the database clock', () => {
    const { sql, params } = render('SCHEDULED')
    // Terms are joined with ` and ` and wrapped as one group.
    expect(sql).toMatch(
      /^\("job_sources"\."enabled" = \$1 and "job_sources"\."admin_state" = \$2 and "job_sources"\."manifest_id" is not null and \(/,
    )
    expect(sql).toMatch(
      / and "job_sources"\."next_attempt_at" <= clock_timestamp\(\) \+ \$6 \* interval '1 millisecond'\)$/,
    )
    expect(sql).toContain('"job_sources"."enabled" = $')
    expect(sql).toContain('"job_sources"."admin_state" = $')
    expect(sql).toContain('"job_sources"."manifest_id" is not null')
    expect(sql).toContain('"job_sources"."trigger_mode" = $')
    expect(sql).toContain('"job_sources"."consecutive_failures" < $')
    expect(sql).toContain('"job_sources"."cooldown_until" IS NULL')
    expect(sql).toContain('"job_sources"."cooldown_until" <= clock_timestamp()')
    expect(sql).toContain('"job_sources"."next_attempt_at" <= clock_timestamp() + $')
    expect(params).toEqual([true, 'ACTIVE', 'BOTH', 'SCHEDULED', MAX_CONSECUTIVE_FAILURES, 0])
  })

  it('a manual predicate drops the cadence term and only that term', () => {
    const scheduled = render('SCHEDULED')
    const manual = render('MANUAL')
    expect(manual.sql).not.toContain('next_attempt_at')
    expect(manual.sql).toContain('"job_sources"."cooldown_until" <= clock_timestamp()')
    expect(manual.sql).toContain('"job_sources"."consecutive_failures" < $')
    expect(manual.sql).toContain('"job_sources"."admin_state" = $')
    expect(manual.params).toEqual([true, 'ACTIVE', 'BOTH', 'MANUAL', MAX_CONSECUTIVE_FAILURES])
    expect(scheduled.params.length - manual.params.length).toBe(1)
  })

  it('the slack and the failure ceiling are parameters, applied to their own terms', () => {
    const { params } = render('SCHEDULED', { cadenceSlackMs: 600_000, maxConsecutiveFailures: 5 })
    expect(params).toEqual([true, 'ACTIVE', 'BOTH', 'SCHEDULED', 5, 600_000])
  })

  it('SR-M-3: a cap above the ceiling, a slack above its maximum or a NaN throws instead of widening', () => {
    expect(() => render('SCHEDULED', { maxConsecutiveFailures: 6 })).toThrow(RangeError)
    expect(() => render('MANUAL', { maxConsecutiveFailures: 99 })).toThrow(RangeError)
    expect(() => render('SCHEDULED', { maxConsecutiveFailures: 0 })).toThrow(RangeError)
    expect(() => render('SCHEDULED', { maxConsecutiveFailures: Number.NaN })).toThrow(RangeError)
    expect(() => render('SCHEDULED', { cadenceSlackMs: 600_001 })).toThrow(
      'invalid cadence slack: 600001',
    )
    expect(() => render('SCHEDULED', { maxConsecutiveFailures: 6 })).toThrow(
      'invalid failure cap: 6',
    )
    expect(() => render('SCHEDULED', { cadenceSlackMs: Number.NaN })).toThrow(RangeError)
    expect(() => render('SCHEDULED', { cadenceSlackMs: -1 })).toThrow(RangeError)
    expect(() =>
      render('SCHEDULED', { cadenceSlackMs: 600_000, maxConsecutiveFailures: 5 }),
    ).not.toThrow()
  })

  it('CR-M-5: a non-integer or infinite cap or slack throws', () => {
    for (const bad of [2.5, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => render('SCHEDULED', { maxConsecutiveFailures: bad })).toThrow(RangeError)
      expect(() => render('MANUAL', { cadenceSlackMs: bad })).toThrow(RangeError)
    }
    expect(() => render('SCHEDULED', { cadenceSlackMs: 0.5 })).toThrow(RangeError)
  })

  it('T8: both triggers carry the host term, its NULL test before the pause test', () => {
    const term = new PgDialect().sqlToQuery(hostOpenPredicate()).sql
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      const { sql } = render(trigger)
      expect(sql).toContain(` and ${term}`)
    }
    expect(term.indexOf('"job_sources"."host_key" IS NOT NULL')).toBe(1)
    expect(term).toContain('AND NOT EXISTS (SELECT 1 FROM job_source_hosts h')
    // The manual predicate ends with it: the cadence term is the only one a manual run drops.
    expect(render('MANUAL').sql.endsWith(`${term})`)).toBe(true)
  })

  it('never reads the stored readiness column', () => {
    expect(render('SCHEDULED').sql).not.toContain('readiness')
  })
})

/** A db whose `select().from().where().orderBy()` chain records what it is given. */
function recordingDb() {
  const seen: { where?: SQL; orderBy?: unknown } = {}
  const rows = [{ id: 'row' }]
  const db = {
    select: () => ({
      from: () => ({
        where: (w: SQL) => {
          seen.where = w
          return {
            orderBy: (o: unknown) => {
              seen.orderBy = o
              return Promise.resolve(rows)
            },
          }
        },
      }),
    }),
  } as unknown as DatabaseService['db']
  return { db, seen, rows }
}

describe('findDueSources (the one query, against a recording db)', () => {
  const dialect = new PgDialect()

  it('selects with the predicate for the trigger, oldest next_attempt_at first, and returns the rows', async () => {
    const { db, seen, rows } = recordingDb()
    const out = await findDueSources(db, 'MANUAL')
    expect(out).toBe(rows)
    expect(seen.where).toBeDefined()
    const { sql, params } = dialect.sqlToQuery(seen.where as SQL)
    expect(params).toEqual([true, 'ACTIVE', 'BOTH', 'MANUAL', MAX_CONSECUTIVE_FAILURES])
    expect(sql).not.toContain('"job_sources"."id" in')
    expect(seen.orderBy).toBe(jobSources.nextAttemptAt)
  })

  it('onlyIds narrows the same predicate to those ids', async () => {
    const { db, seen } = recordingDb()
    await findDueSources(db, 'SCHEDULED', { onlyIds: ['a', 'b'] })
    const { sql, params } = dialect.sqlToQuery(seen.where as SQL)
    expect(sql).toContain('"job_sources"."id" in ($')
    expect(params).toEqual([
      true,
      'ACTIVE',
      'BOTH',
      'SCHEDULED',
      MAX_CONSECUTIVE_FAILURES,
      0,
      'a',
      'b',
    ])
  })

  it('an empty onlyIds selects nothing (it does not mean "no scope")', async () => {
    const { db, seen } = recordingDb()
    await findDueSources(db, 'SCHEDULED', { onlyIds: [] })
    expect(dialect.sqlToQuery(seen.where as SQL).sql).toMatch(/ and false$/)
  })
})
