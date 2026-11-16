import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { DrizzleTx } from '../../database/types'
import { markResumeRecheckNeeded, redactionInputChanged } from './recheck-flag'

const existing = { displayName: 'Olena K', legalFullName: 'Коваль Олена', telegram: '@olena' }

describe('redactionInputChanged (backlog 442)', () => {
  it('a new display name, legal name or Telegram handle is a change', () => {
    expect(redactionInputChanged(existing, { displayName: 'Olena M' })).toBe(true)
    expect(redactionInputChanged(existing, { legalFullName: 'Мороз Олена' })).toBe(true)
    expect(redactionInputChanged(existing, { telegram: '@olena_m' })).toBe(true)
  })

  it('the same values resubmitted are not a change', () => {
    expect(redactionInputChanged(existing, { ...existing, updatedAt: new Date() })).toBe(false)
  })

  it('a write that names no redaction input is not a change', () => {
    expect(redactionInputChanged(existing, { phone: '+380', techStack: ['go'] })).toBe(false)
  })

  it('null to a value and a value to null are changes; null to null is not', () => {
    expect(redactionInputChanged({ telegram: null }, { telegram: '@new' })).toBe(true)
    expect(redactionInputChanged(existing, { telegram: null })).toBe(true)
    expect(redactionInputChanged({ legalFullName: null }, { legalFullName: null })).toBe(false)
  })

  it('an absent existing value counts as null', () => {
    expect(redactionInputChanged({}, { legalFullName: null })).toBe(false)
    expect(redactionInputChanged({}, { legalFullName: 'Коваль Олена' })).toBe(true)
  })
})

/** A tx double: the locked select answers `before`; every call is logged in order. */
function fakeTx(before: Record<string, string | null> | undefined) {
  const log: string[] = []
  const seen: { columns?: string[]; flagWhere?: { sql: string; params: unknown[] } } = {}
  const forFn = vi.fn((mode: string) => {
    log.push(`select for ${mode}`)
    return Promise.resolve(before ? [before] : [])
  })
  const tx = {
    select: (cols: Record<string, unknown>) => {
      seen.columns = Object.keys(cols)
      return { from: () => ({ where: () => ({ for: forFn }) }) }
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (w: SQL) => {
          log.push(`update ${Object.keys(v).join(',')}`)
          seen.flagWhere = new PgDialect().sqlToQuery(w)
          return Promise.resolve()
        },
      }),
    }),
  }
  return { tx: tx as unknown as DrizzleTx, log, forFn, seen }
}

describe('markResumeRecheckNeeded (backlog 442, AC7)', () => {
  it('reads the replaced values FOR NO KEY UPDATE, then flags the resume on a real change', async () => {
    const { tx, log, forFn } = fakeTx(existing)
    await markResumeRecheckNeeded(tx, 'u1', { displayName: 'Olena M' })
    expect(forFn).toHaveBeenCalledWith('no key update')
    expect(log).toEqual(['select for no key update', 'update recheckNeededAt'])
  })

  it('reads all three redaction inputs and flags only the VERIFIED resume of that user', async () => {
    const { tx, seen } = fakeTx(existing)
    await markResumeRecheckNeeded(tx, 'u1', { legalFullName: 'Мороз Олена' })
    expect(seen.columns).toEqual(['displayName', 'legalFullName', 'telegram'])
    expect(seen.flagWhere?.params).toEqual(['u1', 'VERIFIED'])
    expect(seen.flagWhere?.sql).toContain('"verification_status" = $2')
  })

  it('an unchanged value: the locked read, no flag', async () => {
    const { tx, log } = fakeTx(existing)
    await markResumeRecheckNeeded(tx, 'u1', { telegram: '@olena' })
    expect(log).toEqual(['select for no key update'])
  })

  it('a write without a redaction input: no read, no flag', async () => {
    const { tx, log } = fakeTx(existing)
    await markResumeRecheckNeeded(tx, 'u1', { phone: '+380' })
    expect(log).toEqual([])
  })

  it('a missing user: no flag', async () => {
    const { tx, log } = fakeTx(undefined)
    await markResumeRecheckNeeded(tx, 'u1', { displayName: 'X' })
    expect(log).toEqual(['select for no key update'])
  })
})
