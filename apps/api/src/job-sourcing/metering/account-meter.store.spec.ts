import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountMeterError,
  createAccountMeter,
  MAX_METERED_ATTEMPT_ID,
  type AccountMeterBinding,
  type MeterDb,
} from './account-meter.store'

/**
 * The guards that run BEFORE the database (r5 Task 3.5a). The database itself is a stub that
 * records every access: each case asserts it was never touched, so "refused before any query" is
 * a measured claim, not an assumption. Counter behaviour lives in the integration spec.
 */
function untouchableDb(): { db: MeterDb; touched: string[] } {
  const touched: string[] = []
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop))
        throw new Error(`the database was touched (${String(prop)})`)
      },
    },
  ) as MeterDb
  return { db, touched }
}

const valid = (): AccountMeterBinding => ({
  accountKey: 'jsearch:rapidapi-main',
  windows: { REQUEST: 'MONTH' },
  attemptId: 'attempt-1',
  cycleId: randomUUID(),
  runId: null,
})

function constructionError(over: Partial<AccountMeterBinding>): AccountMeterError {
  const { db } = untouchableDb()
  try {
    createAccountMeter(db, { ...valid(), ...over })
  } catch (e) {
    if (e instanceof AccountMeterError) return e
    throw e
  }
  throw new Error('expected construction to throw')
}

async function callError(p: () => Promise<unknown>): Promise<AccountMeterError> {
  try {
    await p()
  } catch (e) {
    if (e instanceof AccountMeterError) return e
    throw e
  }
  throw new Error('expected the call to reject')
}

describe('createAccountMeter — binding validation', () => {
  it('accepts a valid binding without touching the database', () => {
    const { db, touched } = untouchableDb()
    expect(() => createAccountMeter(db, valid())).not.toThrow()
    expect(touched).toEqual([])
  })

  it.each([
    [
      'an account key with a credential-shaped unbroken run',
      { accountKey: 'jsearch:abcdefghijklmnopqrstuvwxyz0123' },
    ],
    ['an uppercase account key', { accountKey: 'JSearch:main' }],
    ['an empty attempt id', { attemptId: '' }],
    ['a whitespace-only attempt id', { attemptId: '   ' }],
    ['an attempt id containing the key separator #', { attemptId: 'attempt#REQUEST#1' }],
    ['a non-uuid cycle id', { cycleId: 'cycle-1' }],
    ['a non-uuid run id', { runId: 'run-1' }],
    ['no metered unit at all', { windows: {} }],
  ] as const)('refuses %s with INVALID_BINDING', (_label, over) => {
    expect(constructionError(over as Partial<AccountMeterBinding>).code).toBe('INVALID_BINDING')
  })

  it('the attempt-id bound is AT the room left for the request suffix: at accepted, past refused', () => {
    expect(MAX_METERED_ATTEMPT_ID).toBe(168)
    const { db } = untouchableDb()
    expect(() => createAccountMeter(db, { ...valid(), attemptId: 'a'.repeat(168) })).not.toThrow()
    expect(constructionError({ attemptId: 'a'.repeat(169) }).code).toBe('INVALID_BINDING')
  })

  it('names the offending field in the error message', () => {
    expect(constructionError({ cycleId: 'nope' }).message).toContain('cycleId')
  })
})

describe('reserve — refused before the database', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'an amount of %s is INVALID_AMOUNT',
    async (amount) => {
      const { db, touched } = untouchableDb()
      const meter = createAccountMeter(db, valid())
      expect((await callError(() => meter.reserve('REQUEST', amount))).code).toBe('INVALID_AMOUNT')
      expect(touched).toEqual([])
    },
  )

  it('a unit the binding does not meter is UNIT_NOT_BOUND', async () => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    expect((await callError(() => meter.reserve('RECORD', 1))).code).toBe('UNIT_NOT_BOUND')
    expect(touched).toEqual([])
  })

  it('the smallest valid amount (1) does reach the database', async () => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    await expect(meter.reserve('REQUEST', 1)).rejects.toThrow('the database was touched')
    expect(touched).toEqual(['transaction'])
  })
})

describe('reconcile / markSent — a claim this binding cannot own is refused before the database', () => {
  it.each([
    ['a unit the binding does not meter', { id: randomUUID(), unit: 'RECORD' as const, amount: 1 }],
    ['a reservation id that is not a uuid', { id: 'r-1', unit: 'REQUEST' as const, amount: 1 }],
  ])('%s is FOREIGN_RESERVATION', async (_label, claim) => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    expect((await callError(() => meter.reconcile(claim, 'USED'))).code).toBe('FOREIGN_RESERVATION')
    expect((await callError(() => meter.markSent(claim))).code).toBe('FOREIGN_RESERVATION')
    expect(touched).toEqual([])
  })

  it('a well-formed claim for a bound unit does reach the database', async () => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    const claim = { id: randomUUID(), unit: 'REQUEST' as const, amount: 1 }
    await expect(meter.reconcile(claim, 'USED')).rejects.toThrow('the database was touched')
    await expect(meter.markSent(claim)).rejects.toThrow('the database was touched')
    expect(touched).toEqual(['transaction', 'transaction'])
  })
})

describe('AccountMeterError', () => {
  it('carries its code and name', () => {
    const e = new AccountMeterError('METER_NOT_FOUND', 'x')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('METER_NOT_FOUND')
    expect(e.name).toBe('AccountMeterError')
    expect(e.message).toBe('x')
  })
})
