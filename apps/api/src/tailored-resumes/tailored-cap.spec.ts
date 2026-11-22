import { HttpException } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { assertUnderDailyCap } from './tailored-cap'

const dialect = new PgDialect()
const NOW = new Date('2026-11-22T10:00:00.000Z')

function fakeDb(count: number) {
  const calls: { sql: string; params: unknown[] }[] = []
  const execute = vi.fn(async (q: SQL) => {
    const { sql, params } = dialect.sqlToQuery(q)
    calls.push({ sql, params })
    return { rows: /count/i.test(sql) ? [{ n: count }] : [] }
  })
  return { db: { execute }, calls }
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )

describe('assertUnderDailyCap', () => {
  it('49 of 50 today passes; the lock comes first, keyed by the scope', async () => {
    const { db, calls } = fakeDb(49)
    await expect(assertUnderDailyCap(db, 'team-1', 50, NOW)).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.sql).toContain(`pg_advisory_xact_lock(hashtext('tailored-cap:' || $1))`)
    expect(calls[0]?.params).toEqual(['team-1'])
    const count = calls[1] as { sql: string; params: unknown[] }
    expect(count.sql).toContain('user_audit_log')
    expect(count.sql).toContain(`action = 'tailored_resume_generate'`)
    expect(count.sql).toContain(`changes->'teamId'->>'after' = $1`)
    expect(count.sql).toContain(`AT TIME ZONE 'Europe/Kyiv'`)
    expect(count.params).toEqual(['team-1', NOW.toISOString(), NOW.toISOString()])
  })

  it('at 50 of 50 → 429 TAILORED_RESUME_DAILY_CAP', async () => {
    const { db } = fakeDb(50)
    const err = await refusal(assertUnderDailyCap(db, 'studio', 50, NOW))
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(429)
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'TAILORED_RESUME_DAILY_CAP',
    })
  })
})
