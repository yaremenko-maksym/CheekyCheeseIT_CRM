import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { MAX_CONSECUTIVE_FAILURES } from './due-policy'
import { dueSourcesPredicate } from './due-sources.query'

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

  it('never reads the stored readiness column', () => {
    expect(render('SCHEDULED').sql).not.toContain('readiness')
  })
})
