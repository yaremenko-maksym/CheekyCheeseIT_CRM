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
const FAKE_METER_ID = '99999999-8888-7777-6666-555544443333'
const FAKE_RESERVATION_ID = '12341234-1234-4234-8234-123412341234'

interface FakeOpts {
  /** The reservation status the locked row comes back with. */
  status?: string
  /** `LIFETIME` makes `rollWindow` return null whatever the clock says. */
  window?: 'DAY' | 'MONTH' | 'LIFETIME'
  /** Rows returned by the reservation -> meter peek. `[]` = no such reservation. */
  peek?: unknown[]
  /** Rows returned by the locked-meter select. `[]` = no meter row. */
  meterRows?: unknown[]
  /** Rows returned by the locked-reservation select. `[]` = no such row on that meter. */
  reservationRows?: unknown[]
  /** Rows returned by `SELECT now()`. `[]` = a clock read that came back empty. */
  clockRows?: unknown[]
  /** Make the clock read REJECT, to exercise failures raised inside the meter lock. */
  clockRejection?: unknown
  /**
   * Which entry point is under test, because the two read the rows in DIFFERENT orders:
   * `reconcile` peeks at the reservation's meter id first, while `reserve` locks the meter first.
   */
  mode?: 'reconcile' | 'reserve'
}

/**
 * A unit double of the Drizzle query layer. It records WRITES, which is what several of the
 * branches below are distinguished by: a decision whose only consequence is "no statement was
 * issued" cannot be caught by looking at the return value.
 *
 * It replays the reads `reconcile` performs, in order — the reservation's meter id, the locked
 * meter row, the database clock, then the locked reservation row.
 */
function fakeMeterDb(opts: FakeOpts = {}) {
  const window = opts.window ?? 'MONTH'
  const meter = {
    id: FAKE_METER_ID,
    window,
    windowStartedAt: window === 'LIFETIME' ? null : new Date('2026-01-01T00:00:00Z'),
    // Far in the future, so no window roll is due and `rollWindow` returns null.
    resetsAt: window === 'LIFETIME' ? null : new Date('2099-01-01T00:00:00Z'),
  }
  const reservation = {
    id: FAKE_RESERVATION_ID,
    meterId: FAKE_METER_ID,
    status: opts.status ?? 'RESERVED',
    amount: 2,
    reservedAt: new Date('2026-06-01T00:00:00Z'),
    sentAt: null,
    settledAt: null,
  }
  const reads: unknown[][] =
    opts.mode === 'reserve'
      ? // `reserve`: the meter lock comes first, then the replay walk's per-ordinal lookups.
        [opts.meterRows ?? [meter], opts.reservationRows ?? []]
      : // `reconcile`: the reservation -> meter peek, then the locked meter, then the locked row.
        [
          opts.peek ?? [{ meterId: FAKE_METER_ID }],
          opts.meterRows ?? [meter],
          opts.reservationRows ?? [reservation],
        ]
  const writes: string[] = []

  const readable = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { for: () => Promise<unknown[]> }
    p.for = () => Promise.resolve(rows)
    return p
  }
  const writable = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & {
      returning: () => Promise<unknown[]>
    }
    p.returning = () => Promise.resolve(rows)
    return p
  }
  const tx = {
    select: () => {
      const node = { from: () => node, where: () => readable(reads.shift() ?? []) }
      return node
    },
    execute: () =>
      opts.clockRejection !== undefined
        ? Promise.reject(opts.clockRejection)
        : Promise.resolve({
            rows: opts.clockRows ?? [{ now: new Date('2026-06-02T00:00:00Z') }],
          }),
    update: () => {
      writes.push('update')
      return { set: () => ({ where: () => writable([meter]) }) }
    },
  }
  const db = {
    transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as MeterDb
  return { db, writes }
}

const claimOf = (unit: 'REQUEST' | 'RECORD' = 'REQUEST') => ({
  id: FAKE_RESERVATION_ID,
  unit,
  amount: 2,
})

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
    const { db, writes } = fakeMeterDb({ status: 'USED' })
    const meter = createAccountMeter(db, valid())
    const error = await callError(() => meter.reconcile(claimOf(), to))
    expect(error.code).toBe('ILLEGAL_TRANSITION')
    expect(error.message).toBe(expected)
    // A refused transition settles nothing.
    expect(writes).toEqual([])
  })

  it('an unmetered unit is named in the refusal', async () => {
    const { db, touched } = untouchableDb()
    const meter = createAccountMeter(db, valid())
    expect((await callError(() => meter.reserve('RECORD', 1))).message).toBe(
      'this binding does not meter RECORD',
    )
    expect(touched).toEqual([])
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

/**
 * The decisions inside `reconcile` that a mocked Drizzle call CAN distinguish. All of these were
 * reported `Survived` — not `NoCoverage` — meaning the unit suite already executed the line and
 * its assertions did not tell the mutant apart. The ones that matter here are the branches whose
 * only consequence is that **no statement is issued**: a return value alone cannot see them, so
 * each case reads the double's write log.
 */
describe('reconcile — the branches a unit double can see', () => {
  it('a reservation that does not exist at all is FOREIGN_RESERVATION, not a crash', async () => {
    // The reservation -> meter peek comes back empty.
    const { db, writes } = fakeMeterDb({ peek: [] })
    const error = await callError(() =>
      createAccountMeter(db, valid()).reconcile(claimOf(), 'USED'),
    )
    expect(error.code).toBe('FOREIGN_RESERVATION')
    expect(writes).toEqual([])
  })

  /**
   * `reserve` is the one entry point where a missing meter row surfaces as itself: `lockOwned`
   * converts METER_NOT_FOUND to FOREIGN_RESERVATION (correctly — a settler must not learn that
   * someone else's meter exists), so this message is unreadable from the settlement paths.
   * A missing row is a CONFIGURATION error and the message has to name which of the three key
   * parts to go and create.
   */
  it('reserve reports a missing meter row as METER_NOT_FOUND, naming the key', async () => {
    const { db, writes } = fakeMeterDb({ mode: 'reserve', meterRows: [] })
    const error = await callError(() => createAccountMeter(db, valid()).reserve('REQUEST', 1))
    expect(error.code).toBe('METER_NOT_FOUND')
    expect(error.message).toBe('no meter row exists for this account, unit and window')
    expect(writes).toEqual([])
  })

  it('a reservation whose meter row is gone is refused as foreign', async () => {
    // The locked-meter select comes back empty: METER_NOT_FOUND, which `lockOwned` converts.
    const { db, writes } = fakeMeterDb({ meterRows: [] })
    const error = await callError(() =>
      createAccountMeter(db, valid()).reconcile(claimOf(), 'USED'),
    )
    expect(error.code).toBe('FOREIGN_RESERVATION')
    expect(writes).toEqual([])
  })

  it('a reservation that is not on that meter under this attempt is refused as foreign', async () => {
    // Peek and meter resolve, but the ownership-filtered reservation select matches nothing.
    const { db, writes } = fakeMeterDb({ reservationRows: [] })
    const error = await callError(() =>
      createAccountMeter(db, valid()).reconcile(claimOf(), 'USED'),
    )
    expect(error.code).toBe('FOREIGN_RESERVATION')
    expect(writes).toEqual([])
  })

  /**
   * The no-op leg of the state machine, and the only assertion that can see it: settling a row
   * into the state it is already in must issue NO statement. Checking that the call merely
   * resolves is not enough — a mutant that stops returning early also resolves, having written.
   * This case also pins the no-roll path, because a window that is not due must not update the
   * meter row either: both mutants show up as a non-empty write log.
   */
  it('settling a row into the state it already holds writes nothing at all', async () => {
    const { db, writes } = fakeMeterDb({ status: 'USED' })
    await expect(
      createAccountMeter(db, valid()).reconcile(claimOf(), 'USED'),
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
  })

  /**
   * DELIBERATELY NOT HERE: a contrast case asserting that a real settlement issues two updates.
   * It existed for one gate run and was removed because of what it measured. The settlement
   * payloads are Drizzle `sql` fragments (`reserved - amount`, `used + amount`), so a double can
   * see THAT two statements were issued and nothing about what they say — and giving the apply
   * block unit coverage on that basis turned twenty of its payload mutants from `NoCoverage` into
   * `Survived`: a test whose green was identical to its absence for every line it newly covered.
   *
   * Those lines need a server to evaluate the arithmetic, which is the integration spec's job and
   * where they are asserted by counter VALUES — every transition, both windows, both hold
   * counters. Per `.claude/rules/common/mutation-gate-integration-specs.md`, `NoCoverage` on
   * integration-only behaviour is the correct and expected report. The no-op case above is kept
   * because its assertion is real: "no statement at all" is observable from here.
   */

  it('an error that merely LOOKS like METER_NOT_FOUND is not turned into a foreign refusal', async () => {
    // The meter lock fails with a plain Error that happens to carry the same `code`. Only an
    // AccountMeterError may be converted; anything else must propagate untouched, or a real fault
    // inside the transaction reaches the caller as "not your reservation" and the attempt is
    // written off instead of retried.
    const { db } = fakeMeterDb({
      clockRejection: Object.assign(new Error('connection reset'), { code: 'METER_NOT_FOUND' }),
    })
    await expect(createAccountMeter(db, valid()).reconcile(claimOf(), 'USED')).rejects.toThrow(
      'connection reset',
    )
  })

  it('a plain failure inside the meter lock propagates, it does not become FOREIGN_RESERVATION', async () => {
    const { db } = fakeMeterDb({ clockRejection: new Error('deadlock detected') })
    await expect(createAccountMeter(db, valid()).reconcile(claimOf(), 'USED')).rejects.toThrow(
      'deadlock detected',
    )
  })

  /**
   * The clock read is defensive: `rows[0]?.now`. Drop the optional chaining and an empty result
   * set throws a TypeError out of the middle of a transaction instead of being tolerated. A
   * LIFETIME meter is used so the window arithmetic never consults the clock, which isolates the
   * read itself — on a windowed meter an unreadable clock has its own consequences.
   */
  it('a clock read that returns no row does not crash the transaction', async () => {
    const { db, writes } = fakeMeterDb({ window: 'LIFETIME', status: 'USED', clockRows: [] })
    const meter = createAccountMeter(db, {
      ...valid(),
      windows: { REQUEST: 'LIFETIME' },
    })
    await expect(meter.reconcile(claimOf(), 'USED')).resolves.toBeUndefined()
    expect(writes).toEqual([])
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
