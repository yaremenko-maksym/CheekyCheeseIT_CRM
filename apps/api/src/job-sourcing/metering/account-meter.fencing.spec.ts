import { randomUUID } from 'node:crypto'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { RunFencedError } from '../ownership/run-ownership'
import {
  AccountMeterError,
  createAccountMeter,
  type AccountMeterBinding,
  type MeterDb,
} from './account-meter.store'

/**
 * r5 Task 2.5 T3 — the meter binding is FENCED by the run ledger. A binding bound to a run carries
 * the run's owner token and epoch, and `reserve`, `markSent` and `reconcile` assert ownership of
 * that run inside their own transaction, after the meter lock and before the reservation lock.
 *
 * A unit double, for the reason `.claude/rules/common/mutation-gate-integration-specs.md` gives:
 * the mutation gate cannot run an integration spec. The real refusal (two executors of one
 * attempt, one fenced) is proven against Postgres in `account-meter.fencing.integration.spec.ts`.
 */
const dialect = new PgDialect()
const METER_ID = '99999999-8888-7777-6666-555544443333'
const RESERVATION_ID = '12341234-1234-4234-8234-123412341234'
const RUN_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'

const runBound = (over: Partial<AccountMeterBinding> = {}): AccountMeterBinding => ({
  accountKey: 'jsearch:main',
  windows: { REQUEST: 'MONTH' },
  attemptId: 'attempt-1',
  cycleId: randomUUID(),
  runId: RUN_ID,
  ownerToken: 'worker-a:token',
  fencingEpoch: 2,
  ...over,
})

interface Script {
  /** What the ownership SELECT returns: `[]` = fenced. */
  owned: unknown[]
  /** The order in which the double was asked for things, for the lock-order assertions. */
  log: string[]
  /** Parameters of the ownership statement, as Postgres would receive them. */
  ownershipParams: unknown[][]
  inserted: unknown[]
}

function fakeDb(owned: unknown[]): { db: MeterDb; script: Script } {
  const script: Script = { owned, log: [], ownershipParams: [], inserted: [] }
  const meter = {
    id: METER_ID,
    window: 'MONTH',
    windowStartedAt: new Date('2026-01-01T00:00:00Z'),
    resetsAt: new Date('2099-01-01T00:00:00Z'),
  }
  const reservation = {
    id: RESERVATION_ID,
    meterId: METER_ID,
    status: 'RESERVED',
    amount: 2,
    usedAmount: 0,
    reservedAt: new Date('2026-06-01T00:00:00Z'),
    sentAt: null,
  }
  const readable = (label: string, rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { for: () => Promise<unknown[]> }
    p.for = () => {
      script.log.push(`lock:${label}`)
      return Promise.resolve(rows)
    }
    return p
  }
  // Reads in the order the store issues them: a peek (markSent/reconcile only), the meter, then
  // reservation rows. `select({ meterId })` is the peek; a bare select is a row read.
  // `reserve` walks with no peek and must find no existing key (so it inserts); markSent and
  // reconcile peek first and then find the claimed reservation.
  let meterRead = false
  let peeked = false
  const tx = {
    select: (projection?: unknown) => {
      const node = {
        from: () => node,
        where: () => {
          if (projection !== undefined) {
            peeked = true
            return readable('peek', [{ meterId: METER_ID }])
          }
          if (!meterRead) {
            meterRead = true
            return readable('meter', [meter])
          }
          return readable('reservation', peeked ? [reservation] : [])
        },
      }
      return node
    },
    execute: (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query)
      if (sql.includes('job_collection_runs')) {
        script.log.push('lock:run')
        script.ownershipParams.push(params)
        return Promise.resolve({ rows: script.owned })
      }
      return Promise.resolve({ rows: [{ now: new Date('2026-06-02T00:00:00Z') }] })
    },
    update: () => ({
      set: () => ({
        where: () => {
          script.log.push('write:update')
          const p = Promise.resolve([meter]) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>
          }
          p.returning = () => Promise.resolve([meter])
          return p
        },
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        script.inserted.push(v)
        return { returning: () => Promise.resolve([{ id: RESERVATION_ID }]) }
      },
    }),
  }
  const db = {
    transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as MeterDb
  return { db, script }
}

const OWNED = [{ id: RUN_ID, account_key: 'jsearch:main', source_id: randomUUID() }]
const claim = { id: RESERVATION_ID, unit: 'REQUEST' as const, amount: 2 }

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('the binding carries ownership exactly when it is bound to a run', () => {
  it('a run-bound binding without a token or an epoch is refused before any query', () => {
    const { db, script } = fakeDb(OWNED)
    for (const over of [{ ownerToken: null }, { fencingEpoch: null }, { ownerToken: undefined }]) {
      expect(() => createAccountMeter(db, runBound(over))).toThrow(AccountMeterError)
    }
    expect(script.log).toEqual([])
  })

  it('a binding with no run may not carry a token', () => {
    const { db } = fakeDb(OWNED)
    expect(() => createAccountMeter(db, runBound({ runId: null, fencingEpoch: null }))).toThrow(
      AccountMeterError,
    )
  })

  it('refuses a non-positive or fractional epoch and an empty token', () => {
    const { db } = fakeDb(OWNED)
    for (const over of [{ fencingEpoch: 0 }, { fencingEpoch: 1.5 }, { ownerToken: '' }]) {
      expect(() => createAccountMeter(db, runBound(over))).toThrow(AccountMeterError)
    }
  })

  it('a binding with neither a run nor a token is accepted (a non-run reservation)', () => {
    const { db } = fakeDb(OWNED)
    expect(() =>
      createAccountMeter(db, runBound({ runId: null, ownerToken: null, fencingEpoch: null })),
    ).not.toThrow()
  })
})

describe('reserve asserts ownership after the meter lock, before the reservation', () => {
  it('a fenced binding is refused with RUN_FENCED and writes nothing', async () => {
    const { db, script } = fakeDb([])
    const err = await rejection(createAccountMeter(db, runBound()).reserve('REQUEST', 2))
    expect(err).toBeInstanceOf(RunFencedError)
    expect((err as RunFencedError).code).toBe('RUN_FENCED')
    expect(script.inserted).toEqual([])
    expect(script.log).toEqual(['lock:meter', 'lock:run'])
  })

  it('the ownership statement carries the binding run, token and epoch', async () => {
    const { db, script } = fakeDb([])
    await rejection(createAccountMeter(db, runBound()).reserve('REQUEST', 2))
    expect(script.ownershipParams[0]).toEqual([RUN_ID, 'worker-a:token', 2])
  })

  it('an owned binding writes run_id from the asserted row', async () => {
    const { db, script } = fakeDb(OWNED)
    const r = await createAccountMeter(db, runBound()).reserve('REQUEST', 2)
    expect(r).toEqual({ id: RESERVATION_ID, unit: 'REQUEST', amount: 2 })
    expect(script.inserted).toEqual([
      expect.objectContaining({ runId: RUN_ID, attemptId: 'attempt-1#REQUEST#1', amount: 2 }),
    ])
    expect(script.log.slice(0, 3)).toEqual(['lock:meter', 'lock:run', 'lock:reservation'])
  })

  it('a run of ANOTHER account is refused, so a binding cannot spend outside its run', async () => {
    const { db, script } = fakeDb([{ ...OWNED[0], account_key: 'other:acct' }])
    const err = await rejection(createAccountMeter(db, runBound()).reserve('REQUEST', 2))
    expect((err as AccountMeterError).code).toBe('INVALID_BINDING')
    expect(script.inserted).toEqual([])
  })

  it('a binding with no run asserts nothing', async () => {
    const { db, script } = fakeDb([])
    await createAccountMeter(
      db,
      runBound({ runId: null, ownerToken: null, fencingEpoch: null }),
    ).reserve('REQUEST', 2)
    expect(script.log).not.toContain('lock:run')
    expect(script.inserted).toEqual([expect.objectContaining({ runId: null })])
  })
})

describe('markSent and reconcile assert ownership between the meter and reservation locks', () => {
  it('markSent of a fenced binding is refused and writes nothing', async () => {
    const { db, script } = fakeDb([])
    const err = await rejection(createAccountMeter(db, runBound()).markSent(claim))
    expect(err).toBeInstanceOf(RunFencedError)
    expect(script.log).toEqual(['lock:meter', 'lock:run'])
    expect(script.log).not.toContain('write:update')
  })

  it('reconcile of a fenced binding is refused and writes nothing', async () => {
    const { db, script } = fakeDb([])
    const err = await rejection(createAccountMeter(db, runBound()).reconcile(claim, 'USED'))
    expect(err).toBeInstanceOf(RunFencedError)
    expect(script.log).toEqual(['lock:meter', 'lock:run'])
  })

  it('markSent of an owned binding locks meter, run, reservation, then writes', async () => {
    const { db, script } = fakeDb(OWNED)
    await createAccountMeter(db, runBound()).markSent(claim)
    expect(script.log).toEqual(['lock:meter', 'lock:run', 'lock:reservation', 'write:update'])
  })
})
