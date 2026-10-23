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
/**
 * A unit double of the Drizzle query layer, for the one reason
 * `.claude/rules/common/mutation-gate-integration-specs.md` gives: **the mutation gate runs the
 * unit suite only and cannot execute an `*.integration.spec.ts`.** The refused-transition path is
 * reachable solely through `reconcile`, which needs a database, so it was proven only in the
 * integration spec — and the gate therefore saw nothing there and reported the whole
 * `ILLEGAL_TRANSITION` constructor as a live mutant at the previous head. Per that rule this
 * double is a requirement of the tool, not duplication: the integration spec keeps verifying the
 * real transition against real Postgres, and this makes the same line visible to the gate.
 *
 * It replays exactly the reads `reconcile` performs, in order — the reservation's meter id, the
 * locked meter row, the database clock, then the locked reservation row. `resetsAt` is far in the
 * future so no window roll is due and no UPDATE is attempted; an unexpected write throws rather
 * than passing silently.
 */
function settledReservationDb(status: string, reservationId: string) {
  const meter = {
    id: '99999999-8888-7777-6666-555544443333',
    window: 'MONTH',
    windowStartedAt: new Date('2026-01-01T00:00:00Z'),
    resetsAt: new Date('2099-01-01T00:00:00Z'),
  }
  const reservation = {
    id: reservationId,
    meterId: meter.id,
    status,
    amount: 2,
    reservedAt: new Date('2026-06-01T00:00:00Z'),
    sentAt: null,
    settledAt: null,
  }
  const reads: unknown[][] = [[{ meterId: meter.id }], [meter], [reservation]]

  const resultOf = (rows: unknown[]) => {
    const settled = Promise.resolve(rows) as Promise<unknown[]> & {
      for: () => Promise<unknown[]>
    }
    settled.for = () => Promise.resolve(rows)
    return settled
  }
  const select = () => {
    const node = {
      from: () => node,
      where: () => resultOf(reads.shift() ?? []),
    }
    return node
  }
  const tx = {
    select,
    execute: () => Promise.resolve({ rows: [{ now: new Date('2026-06-02T00:00:00Z') }] }),
    update: () => {
      throw new Error('the refused-transition path must not write')
    },
  }
  return {
    transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as MeterDb
}

describe('error messages carry what their reader must act on', () => {
  /**
   * The refusal an operator meets while money is stuck on a reservation that will not settle. Both
   * states have to be in the sentence: "which transition was refused" is the whole question, and
   * the answer decides whether they go looking at the worker or at the ledger.
   */
  it.each([
    ['UNCERTAIN', 'a USED reservation cannot become UNCERTAIN'] as const,
    ['RELEASED', 'a USED reservation cannot become RELEASED'] as const,
  ])('a refused USED -> %s names both states', async (to, expected) => {
    const id = '12341234-1234-4234-8234-123412341234'
    const meter = createAccountMeter(settledReservationDb('USED', id), valid())
    const error = await callError(() =>
      meter.reconcile({ id, unit: 'REQUEST', amount: 2 }, to as 'UNCERTAIN' | 'RELEASED'),
    )
    expect(error.code).toBe('ILLEGAL_TRANSITION')
    expect(error.message).toBe(expected)
  })

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

  /**
   * THE COMPOSED binding message, asserted whole. The ten messages asserted elsewhere in this file
   * are string CONSTANTS; this one is assembled — the zod issue path joined with `.`, the issues
   * joined with `; ` — and the two separators are invisible to every assertion above, which is
   * why both survived the mutation gate at the previous head. Neither shows up in a one-issue,
   * one-segment error: `['cycleId'].join('.')` and `.join('')` are the same string, and a single
   * issue never reaches the `; `. So the case needs TWO invalid fields, one of them nested.
   *
   * `windows.REQUEST` is the nested path (a bad window value under a valid unit key) and `cycleId`
   * is the second issue. The zod wordings inside are an EXTERNAL fact, measured once against the
   * pinned zod v4 — what this assertion is for is the composition around them, so the second
   * assertion states each separator's role on its own and will say which of the two broke.
   */
  it('composes several issues into one message: paths joined by ".", issues by "; "', () => {
    const message = constructionError({
      windows: { REQUEST: 'WEEK' } as never,
      cycleId: 'nope',
    }).message

    expect(message).toBe(
      'the meter binding is invalid: windows.REQUEST Invalid option: expected one of ' +
        '"DAY"|"MONTH"|"LIFETIME"; cycleId Invalid UUID',
    )

    // The composition alone, independent of zod's wording: the nested path keeps its dot, and the
    // two issues stay separated. A separator mutated to the empty string fails here too.
    expect(message).toMatch(/windows\.REQUEST .+; cycleId /)
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
