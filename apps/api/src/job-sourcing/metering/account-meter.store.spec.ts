import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountMeterError,
  createAccountMeter,
  MAX_METERED_ATTEMPT_ID,
  MAX_RESERVATION_AMOUNT,
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

/**
 * THE MESSAGE TEXT, asserted rather than suppressed — nine string literals survived the mutation
 * gate because no case read any of them. The choice is per message, and here it came out the same
 * way for all nine: every one of these names the thing its reader has to act on, so replacing the
 * text with anything else loses information a person needs.
 *
 * The two that decide it are the refusals an operator meets while money is stuck: a reservation
 * that will not settle says WHICH transition was refused (both states), and a claim refused for
 * ownership says the binding does not own it rather than that the reservation is missing — those
 * two readings lead to different actions. The rest name the unit, the field or the rule that
 * failed, which is what turns a rejected binding into a fixable one. Nothing here is decorative,
 * so nothing here is suppressed.
 *
 * The expected substrings are written out, not taken from the source, so a message that silently
 * changes meaning fails rather than following along.
 */
describe('error messages carry what their reader must act on', () => {
  // The refused-transition wording needs a real settled row to re-settle, so it is asserted in
  // the integration spec ("a USED reservation cannot be downgraded or released afterwards").

  it('an unmetered unit is named in the refusal', async () => {
    const { db } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    expect((await callError(() => meter.reserve('RECORD', 1))).message).toBe(
      'this binding does not meter RECORD',
    )
  })

  it('an invalid amount says what a valid one is', async () => {
    const { db } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    expect((await callError(() => meter.reserve('REQUEST', 0))).message).toBe(
      'a reservation amount is a positive integer',
    )
  })

  it('a foreign reservation says the binding does not OWN it, not that it is missing', async () => {
    const { db } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    const error = await callError(() =>
      meter.reconcile({ id: 'not-a-uuid', unit: 'REQUEST', amount: 1 }, 'USED'),
    )
    expect(error.code).toBe('FOREIGN_RESERVATION')
    expect(error.message).toBe('this binding does not own that reservation')
  })

  it('an invalid binding is prefixed and carries the failing rule', () => {
    expect(constructionError({ cycleId: 'nope' }).message).toContain('the meter binding is invalid')
  })

  it.each([
    [{ windows: {} }, 'at least one unit must be metered'],
    [{ attemptId: '   ' }, 'attempt id must not be blank'],
    [{ attemptId: 'a#b' }, 'attempt id must not contain #'],
  ] as const)('the binding rule that failed is quoted: %o', (over, rule) => {
    expect(constructionError(over as Partial<AccountMeterBinding>).message).toContain(rule)
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

/**
 * SR-M-2 — the per-unit sanity ceiling. The ceilings are written out as literals here rather than
 * read from `MAX_RESERVATION_AMOUNT`: a case that takes its expectation from the table under test
 * passes whatever the table says, including after someone raises a bound by mistake. Each unit
 * gets a case AT its ceiling (accepted — it reaches the database) and one PAST it (refused before
 * any query), which is also what pins the bound as a bound rather than an approximation.
 */
describe('reserve — the per-unit sanity ceiling (SR-M-2)', () => {
  const ceilings = [
    ['REQUEST', 10_000],
    ['RECORD', 100_000],
    ['MODEL_CALL', 10_000],
    ['USD_MICROS', 1_000_000_000],
  ] as const

  it('the ceilings in the table are the documented ones', () => {
    expect(MAX_RESERVATION_AMOUNT).toEqual({
      REQUEST: 10_000,
      RECORD: 100_000,
      MODEL_CALL: 10_000,
      USD_MICROS: 1_000_000_000,
    })
  })

  it.each(ceilings)('a %s amount exactly AT the ceiling (%i) is accepted', async (unit, max) => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, { ...valid(), windows: { [unit]: 'MONTH' } })
    await expect(meter.reserve(unit, max)).rejects.toThrow('the database was touched')
    expect(touched).toEqual(['transaction'])
  })

  it.each(ceilings)('a %s amount one past the ceiling (%i) is refused', async (unit, max) => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, { ...valid(), windows: { [unit]: 'MONTH' } })
    const error = await callError(() => meter.reserve(unit, max + 1))
    expect(error.code).toBe('INVALID_AMOUNT')
    // Not a COST_STOP: a budget refusal is `null`, a cost estimate this size is a defect.
    expect(error.message).toContain('sanity ceiling')
    expect(touched).toEqual([])
  })

  /**
   * The case the finding measured: an UNLIMITED meter (`limit_amount IS NULL`) used to accept
   * `Number.MAX_SAFE_INTEGER`, writing nine billion dollars of held spend onto a USD_MICROS row.
   * The ceiling does not consult the limit, so it refuses this before any query.
   */
  it.each(ceilings)('MAX_SAFE_INTEGER is refused for %s, whatever the limit', async (unit) => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, { ...valid(), windows: { [unit]: 'MONTH' } })
    expect((await callError(() => meter.reserve(unit, Number.MAX_SAFE_INTEGER))).code).toBe(
      'INVALID_AMOUNT',
    )
    expect(touched).toEqual([])
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
