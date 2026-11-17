import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { dirtyConsumerOf } from '../ownership/dirty-work.store'
import { LockContentionError } from './lock-order'
import {
  CanonicalStateError,
  ForbiddenActorError,
  asAdminActor,
  linkRecordTx,
  releaseTokenTx,
  resolveRecordsTx,
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

const dialect = new PgDialect()

function fakeDb(attempts: readonly (readonly Step[])[]) {
  const seen = {
    transactions: 0,
    options: [] as unknown[],
    setLocal: [] as string[],
    queries: [] as { sql: string; params: unknown[] }[],
  }
  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>, options: unknown): Promise<T> {
      const steps = attempts[seen.transactions] ?? []
      seen.transactions += 1
      seen.options.push(options)
      let call = 0
      const tx = {
        async execute(query: SQL & { queryChunks?: unknown[] }) {
          seen.queries.push(dialect.sqlToQuery(query))
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

  it('resolveRecordsTx runs resolveRecords in its own transaction and returns its outcomes', async () => {
    const { db, seen } = fakeDb([[]])
    await expect(resolveRecordsTx(db, [])).resolves.toEqual([])
    expect(seen.transactions).toBe(1)
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

  it('a new canonical revision is enqueued through the dirty-work store in the same transaction (Task 4.6 S4a)', async () => {
    // releaseOk, but the opportunity refresh returns its new revision.
    const { db, seen } = fakeDb([[...releaseOk.slice(0, 6), [{ revision: 7 }], []]])
    await releaseTokenTx(db, actor, 'k', 'why')
    expect(seen.transactions).toBe(1)
    const enqueue = seen.queries.filter((q) => /INSERT INTO job_dirty_work/.test(q.sql))
    // S-P2 (ADR 2026-11-02 step 3): one row per consumer at the new revision.
    expect(enqueue.map((q) => q.params)).toEqual([
      ['OPPORTUNITY', OPP, 7, 'CANONICAL_REVISION', null],
      ['OPPORTUNITY', OPP, 7, 'AVAILABILITY:CANONICAL_REVISION', null],
    ])
    expect(enqueue.map((q) => dirtyConsumerOf(String(q.params[3])))).toEqual([
      'MATCH',
      'AVAILABILITY',
    ])
    for (const q of enqueue) expect(q.sql).toMatch(/DO NOTHING\s+RETURNING id/)
  })

  it('an unrelated database error is not retried', async () => {
    const { db, seen } = fakeDb([[pgError('23505')], releaseOk])
    await expect(releaseTokenTx(db, actor, 'k', 'r')).rejects.toThrow('Failed query')
    expect(seen.transactions).toBe(1)
  })
})

/**
 * Senior roles PR 2 Task 2.3: a refresh re-derives the vacancy roles only when a classifier input
 * moved, in its own UPDATE apart from the revision tuple. Scripted through `releaseTokenTx`, the
 * one wrapper whose refresh reads the members and the stored row in a fixed order.
 */
describe('refresh reclassifies vacancy roles only when a classifier input moved (senior roles PR 2)', () => {
  const SHA = 'b'.repeat(64)
  const member = {
    record_id: '33333333-3333-4333-8333-333333333333',
    revision_id: 'rev-1',
    received_seq: 1,
    received_at: '2026-11-17T00:00:00.000Z',
    source_type: 'GREENHOUSE',
    namespace: 'acme',
    normalized: { title: 'Senior Backend Engineer', companyName: 'Acme', tags: ['go'] },
    description_sha256: SHA,
  }
  const stored = (over: Record<string, unknown> = {}) => ({
    title: 'Senior Backend Engineer',
    stack_keywords: ['go'],
    description_sha256: SHA,
    ...over,
  })
  // releaseOk up to the token UPDATE, then: members, the stored row, then whatever follows.
  const refresh = (membersRows: Rows, storedRows: Rows, rest: Step[]): Step[] => [
    ...releaseOk.slice(0, 4),
    membersRows,
    storedRows,
    ...rest,
  ]
  const roleWrites = (queries: { sql: string; params: unknown[] }[]) =>
    queries.filter((q) => /^UPDATE job_opportunities\s+SET technical_roles = /.test(q.sql))

  it('reads the classifier inputs with the stored title', async () => {
    const { db, seen } = fakeDb([refresh([member], [stored()], [[], []])])
    await releaseTokenTx(db, actor, 'k', 'why')
    const read = seen.queries.find((q) => /FROM job_opportunities WHERE id = /.test(q.sql))
    expect(read?.sql).toContain('SELECT title, stack_keywords, description_sha256 FROM')
  })

  it.each([
    ['title', stored({ title: 'Old Title' })],
    ['stack keywords', stored({ stack_keywords: ['rust'] })],
    ['description hash', stored({ description_sha256: 'c'.repeat(64) })],
  ])('a moved %s rewrites the 3 role columns from the rule classifier', async (_, row) => {
    const { db, seen } = fakeDb([refresh([member], [row], [[], [], []])])
    await releaseTokenTx(db, actor, 'k', 'why')
    expect(roleWrites(seen.queries).map((q) => q.params)).toEqual([
      ['["BACKEND_ENGINEER"]', 'RULE', 'rc.1', OPP],
    ])
  })

  it('unchanged classifier inputs keep the stored roles: no role write', async () => {
    const { db, seen } = fakeDb([refresh([member], [stored()], [[], []])])
    await releaseTokenTx(db, actor, 'k', 'why')
    expect(roleWrites(seen.queries)).toEqual([])
    expect(seen.queries.some((q) => /revision = revision \+ 1/.test(q.sql))).toBe(true)
  })

  it('a refresh that finds no stored row writes no roles', async () => {
    const { db, seen } = fakeDb([refresh([member], [], [[], []])])
    await releaseTokenTx(db, actor, 'k', 'why')
    expect(roleWrites(seen.queries)).toEqual([])
  })

  it('an opportunity left with no member keeps its roles and still advances its revision', async () => {
    const { db, seen } = fakeDb([refresh([], [stored({ title: 'Old Title' })], [[], []])])
    await releaseTokenTx(db, actor, 'k', 'why')
    expect(roleWrites(seen.queries)).toEqual([])
    expect(seen.queries.some((q) => /revision = revision \+ 1/.test(q.sql))).toBe(true)
  })
})
