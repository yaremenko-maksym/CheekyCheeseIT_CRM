import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { LockContentionError } from './lock-order'
import {
  CanonicalStateError,
  ForbiddenActorError,
  asAdminActor,
  linkRecordTx,
  releaseTokenTx,
  splitRecordTx,
} from './canonical.store'

/** Task 4.6 / S2: the own-transaction wrappers' retry contract, on a scripted fake `db`. */

const ID = '11111111-1111-4111-8111-111111111111'
const OPP = '22222222-2222-4222-8222-222222222222'
const actor = asAdminActor({ id: ID, role: 'ADMIN' })

const pgError = (code: string) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('db'), { code, severity: 'ERROR' }),
  })

type Rows = Record<string, unknown>[]
/** Per attempt: the rows each `execute` returns after the `SET LOCAL`, or an error to throw. */
type Step = Rows | Error
const ok: Rows = [{ ok: 1 }]

function fakeDb(attempts: readonly (readonly Step[])[]) {
  const seen = { transactions: 0, options: [] as unknown[], setLocal: [] as string[] }
  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>, options: unknown): Promise<T> {
      const steps = attempts[seen.transactions] ?? []
      seen.transactions += 1
      seen.options.push(options)
      let call = 0
      const tx = {
        async execute(query: { queryChunks?: unknown[] }) {
          if (call === 0) {
            call += 1
            seen.setLocal.push(
              JSON.stringify(query.queryChunks?.map((c) => (c as { value?: unknown }).value)),
            )
            return { rows: [] }
          }
          const step = steps[call - 1]
          call += 1
          if (step instanceof Error) throw step
          return { rows: step ?? [] }
        },
      }
      return fn(tx)
    },
  }
  return { db: db as unknown as MeterDb, seen }
}

/** The statements `releaseToken` runs after the admin check, for a successful release. */
const releaseOk: Step[] = [
  ok,
  [{ opportunity_id: OPP }],
  [{ id: OPP }],
  [{ id: 'tok' }],
  [],
  [],
  [],
]

describe('own-transaction wrappers (Task 4.6 / S2)', () => {
  it('releaseTokenTx re-runs a deadlocked attempt and succeeds (2 attempts)', async () => {
    const { db, seen } = fakeDb([[pgError('40P01')], releaseOk])
    await expect(releaseTokenTx(db, actor, 'k', 'why')).resolves.toBeUndefined()
    expect(seen.transactions).toBe(2)
  })

  it('every attempt is a read committed transaction with the lock timeout set first', async () => {
    const { db, seen } = fakeDb([releaseOk])
    await releaseTokenTx(db, actor, 'k', 'why', { lockTimeoutMs: 1234 })
    expect(seen.options).toEqual([{ isolationLevel: 'read committed' }])
    expect(seen.setLocal[0]).toContain('1234ms')
  })

  it.each([
    ['linkRecordTx', (db: MeterDb) => linkRecordTx(db, actor, ID, OPP, 'r')],
    ['splitRecordTx', (db: MeterDb) => splitRecordTx(db, actor, ID, 'r')],
    ['releaseTokenTx', (db: MeterDb) => releaseTokenTx(db, actor, 'k', 'r')],
  ])('%s: a persistent deadlock is bounded at 3 attempts, then typed', async (_n, run) => {
    const { db, seen } = fakeDb([[pgError('40P01')], [pgError('40P01')], [pgError('40P01')], [ok]])
    const err = await run(db).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockContentionError)
    expect(err).toMatchObject({ sqlstate: '40P01', attempts: 3 })
    expect(seen.transactions).toBe(3)
  })

  it.each([
    ['linkRecordTx', (db: MeterDb) => linkRecordTx(db, actor, ID, OPP, 'r')],
    ['splitRecordTx', (db: MeterDb) => splitRecordTx(db, actor, ID, 'r')],
    ['releaseTokenTx', (db: MeterDb) => releaseTokenTx(db, actor, 'k', 'r')],
  ])('%s: a lock timeout surfaces as the typed LockContentionError', async (_n, run) => {
    const { db } = fakeDb([[pgError('55P03')], [pgError('55P03')], [pgError('55P03')]])
    const err = await run(db).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockContentionError)
    expect(err).toMatchObject({ code: 'LOCK_CONTENTION', sqlstate: '55P03', attempts: 3 })
  })

  it('a fenced actor (demoted ADMIN) is not retried', async () => {
    const { db, seen } = fakeDb([[[]], [ok]])
    await expect(releaseTokenTx(db, actor, 'k', 'r')).rejects.toBeInstanceOf(ForbiddenActorError)
    expect(seen.transactions).toBe(1)
  })

  it('an ownership/state failure is not retried', async () => {
    const { db, seen } = fakeDb([
      [ok, []],
      [ok, []],
    ])
    await expect(releaseTokenTx(db, actor, 'k', 'r')).rejects.toBeInstanceOf(CanonicalStateError)
    expect(seen.transactions).toBe(1)
  })

  it('an unrelated database error is not retried', async () => {
    const { db, seen } = fakeDb([[pgError('23505')], releaseOk])
    await expect(releaseTokenTx(db, actor, 'k', 'r')).rejects.toThrow('Failed query')
    expect(seen.transactions).toBe(1)
  })
})
