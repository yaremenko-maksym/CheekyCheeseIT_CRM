import { Logger } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { jobModelHealthFlags } from '../database/schema'
import { readSourcingNotice } from './sourcing-notice'

/** A fake of the one select chain the read uses; `rows` is what the flag table answers. */
function fakeDb(rows: Promise<unknown[]>) {
  const limit = vi.fn(() => rows)
  const where = vi.fn((_condition: SQL | undefined) => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { db: { select } as unknown as DatabaseService['db'], select, from, where, limit }
}

afterEach(() => vi.restoreAllMocks())

describe('readSourcingNotice (ADR 2026-11-03 §H.8)', () => {
  it('a raised, not cleared MODEL_LIMITS_EXHAUSTED row gives AI_LIMITS_EXHAUSTED', async () => {
    const fake = fakeDb(Promise.resolve([{ flag: 'MODEL_LIMITS_EXHAUSTED' }]))
    await expect(readSourcingNotice(fake.db)).resolves.toBe('AI_LIMITS_EXHAUSTED')
    expect(fake.limit).toHaveBeenCalledWith(1)
  })

  it('reads only the not-cleared MODEL_LIMITS_EXHAUSTED row of the flag table', async () => {
    const fake = fakeDb(Promise.resolve([]))
    await readSourcingNotice(fake.db)
    expect(fake.select).toHaveBeenCalledWith({ flag: jobModelHealthFlags.flag })
    expect(fake.from).toHaveBeenCalledWith(jobModelHealthFlags)
    const condition = fake.where.mock.calls[0]?.[0]
    if (!condition) throw new Error('the read must filter the flag table')
    const compiled = new PgDialect().sqlToQuery(condition)
    expect(compiled.params).toEqual(['MODEL_LIMITS_EXHAUSTED'])
    expect(compiled.sql).toContain('"cleared_at" is null')
  })

  it('no such row (never raised, or cleared) gives null', async () => {
    await expect(readSourcingNotice(fakeDb(Promise.resolve([])).db)).resolves.toBeNull()
  })

  it('a failed read gives null and one fixed-code error line, never a thrown list', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const failure = new Error('relation "job_model_health_flags" does not exist')
    const fake = fakeDb(Promise.reject(failure))
    await expect(readSourcingNotice(fake.db)).resolves.toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
    const [message, stack] = error.mock.calls[0] ?? []
    expect(typeof message).toBe('string')
    expect(message?.startsWith('SOURCING_NOTICE_READ_FAILED')).toBe(true)
    expect(typeof stack).toBe('string')
    expect(stack).toContain('relation "job_model_health_flags" does not exist')
  })

  it('a pg error code reaches the logged message', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const pgErr = Object.assign(new Error('relation "job_model_health_flags" does not exist'), {
      code: '42P01',
      severity: 'ERROR',
    })
    const fake = fakeDb(Promise.reject(pgErr))
    await expect(readSourcingNotice(fake.db)).resolves.toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
    const [message, stack] = error.mock.calls[0] ?? []
    expect(typeof message).toBe('string')
    expect(message?.startsWith('SOURCING_NOTICE_READ_FAILED')).toBe(true)
    expect(message).toContain('db_state=42P01')
    expect(typeof stack).toBe('string')
  })
})
