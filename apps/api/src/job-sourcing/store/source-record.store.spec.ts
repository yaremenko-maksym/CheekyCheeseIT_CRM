import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { identityObservations, specCheckpoint } from '../../test/ledger-fixtures'
import type { MeterDb } from '../metering/account-meter.store'
import { RunFencedError } from '../ownership/run-ownership'
import { LockContentionError } from './lock-order'
import {
  MAX_OBSERVATIONS_PER_PAGE,
  type PageChunk,
  chunkPage,
  saveObservationPage,
} from './source-record.store'

/**
 * r5 Task 4.6 S1 — the record store's page write as the run worker uses it, against a recording
 * transaction double: the page-write budget, the bounded retry, the fence, and the chunking of a
 * page above the store's cap. The same writes against a real Postgres are in
 * `source-record.store.integration.spec.ts`.
 */
const dialect = new PgDialect()
const H = {
  runId: '00000000-0000-4000-8000-000000000101',
  ownerToken: 'spec:1',
  fencingEpoch: 1,
}
type Query = { sql: string; params: unknown[] }

/** A database whose every transaction runs `fn` on a `tx` that answers through `answer`. */
function recordingDb(answer: (q: Query) => { rows: Record<string, unknown>[] }) {
  const seen = { transactions: 0, statements: [] as Query[] }
  const db = {
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      seen.transactions += 1
      return fn({
        async execute(query: SQL) {
          const q = dialect.sqlToQuery(query)
          seen.statements.push(q)
          return answer(q)
        },
      })
    },
  } as unknown as MeterDb
  return { db, seen }
}

/** An owned REMOTIVE_API run whose checkpoint UPDATE matches one row. */
const owned = (q: Query) => {
  if (/FROM job_collection_runs WHERE id =/.test(q.sql)) {
    return { rows: [{ id: H.runId, account_key: 'a', source_id: 's' }] }
  }
  if (/SELECT type FROM job_sources/.test(q.sql)) return { rows: [{ type: 'REMOTIVE_API' }] }
  if (/^\s*UPDATE job_collection_runs/.test(q.sql)) return { rows: [{ ok: 1 }] }
  return { rows: [] }
}

const ids = (chunk: PageChunk) => chunk.observations.map((o) => o.identity.nativeId)

describe('chunkPage (Task 4.6 S1, AC 6)', () => {
  const cp = specCheckpoint(4)

  it('a page within the cap is one chunk, the page itself', () => {
    const page = { observations: identityObservations(['a', 'b'], 'n'), checkpoint: cp }
    expect(chunkPage(page, 2)).toEqual([page])
    expect(chunkPage(page, 2)[0]).toBe(page)
  })

  it('splits a larger page at the cap and moves the checkpoint with the last chunk only', () => {
    const page = { observations: identityObservations(['a', 'b', 'c', 'd'], 'n'), checkpoint: cp }
    const chunks = chunkPage(page, 3)
    expect(chunks.map(ids)).toEqual([['a', 'b', 'c'], ['d']])
    expect(chunks.map((c) => c.checkpoint)).toEqual([null, cp])
  })

  it('keeps every observation of one identity in one chunk, in arrival order', () => {
    const [a1, b, a2, c, d] = identityObservations(['a', 'b', 'a', 'c', 'd'], 'n')
    const chunks = chunkPage({ observations: [a1!, b!, a2!, c!, d!], checkpoint: cp }, 3)
    expect(chunks.map((ch) => ch.observations)).toEqual([
      [a1, a2, b],
      [c, d],
    ])
  })

  it('an identity larger than the room left starts a new chunk; one larger than the cap stays whole', () => {
    const page = {
      observations: identityObservations(['a', 'b', 'b', 'b', 'c'], 'n'),
      checkpoint: cp,
    }
    expect(chunkPage(page, 3).map(ids)).toEqual([['a'], ['b', 'b', 'b'], ['c']])
    const huge = { observations: identityObservations(['x', 'x', 'x', 'y'], 'n'), checkpoint: cp }
    expect(chunkPage(huge, 2).map(ids)).toEqual([['x', 'x', 'x'], ['y']])
  })

  it('one native id in two namespaces is two identities', () => {
    const page = {
      observations: [...identityObservations(['a'], 'n1'), ...identityObservations(['a'], 'n2')],
      checkpoint: cp,
    }
    expect(chunkPage(page, 1).map((c) => c.observations.map((o) => o.identity.namespace))).toEqual([
      ['n1'],
      ['n2'],
    ])
  })

  it('defaults to the store cap: 500 is one chunk, 501 is two', () => {
    const page = (n: number) => ({
      observations: identityObservations(
        Array.from({ length: n }, (_, i) => `j${i}`),
        'n',
      ),
      checkpoint: cp,
    })
    expect(MAX_OBSERVATIONS_PER_PAGE).toBe(500)
    expect(chunkPage(page(500))).toHaveLength(1)
    expect(chunkPage(page(501)).map((c) => c.observations.length)).toEqual([500, 1])
  })
})

describe('saveObservationPage: budget, retry, fence (Task 4.6 S1, AC 5)', () => {
  const empty = { observations: [], checkpoint: specCheckpoint(2) }

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    'refuses timeoutMs %s before any transaction',
    async (t) => {
      const { db, seen } = recordingDb(owned)
      await expect(saveObservationPage(db, H, empty, { timeoutMs: t })).rejects.toThrow(
        new RangeError('saveObservationPage: invalid timeout'),
      )
      expect(seen.transactions).toBe(0)
    },
  )

  it('a budget sets statement_timeout AND lock_timeout, as bound parameters', async () => {
    const { db, seen } = recordingDb(owned)
    await saveObservationPage(db, H, empty, { timeoutMs: 1_500 })
    expect(seen.statements[0]).toMatchObject({
      sql: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      params: ['1500ms', '1500ms'],
    })
  })

  it('without a budget only lock_timeout is set: the store default, or the given one', async () => {
    const plain = recordingDb(owned)
    await saveObservationPage(plain.db, H, empty)
    expect(plain.seen.statements[0]?.sql).toBe(`SET LOCAL lock_timeout = '5000ms'`)
    const given = recordingDb(owned)
    await saveObservationPage(given.db, H, empty, { lockTimeoutMs: 100 })
    expect(given.seen.statements[0]?.sql).toBe(`SET LOCAL lock_timeout = '100ms'`)
  })

  it('writes the checkpoint with the page, and keeps it for a chunk (checkpoint null)', async () => {
    const page = recordingDb(owned)
    await saveObservationPage(page.db, H, empty)
    const update = page.seen.statements.at(-1)
    expect(JSON.parse(String(update?.params[0]))).toMatchObject({ position: { page: 2 } })
    const chunk = recordingDb(owned)
    await saveObservationPage(chunk.db, H, { observations: [], checkpoint: null })
    expect(chunk.seen.statements.at(-1)?.params[0]).toBeNull()
  })

  it('a lock timeout is retried, bounded, then typed', async () => {
    const { db, seen } = recordingDb((q) => {
      if (/FROM job_collection_runs WHERE id =/.test(q.sql))
        throw { code: '55P03', severity: 'ERROR' }
      return owned(q)
    })
    const err = await saveObservationPage(db, H, empty, { timeoutMs: 50 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockContentionError)
    expect(err).toMatchObject({ sqlstate: '55P03', attempts: 3 })
    expect(seen.transactions).toBe(3)
  })

  it('a fenced run is never retried', async () => {
    const { db, seen } = recordingDb((q) =>
      /FROM job_collection_runs WHERE id =/.test(q.sql) ? { rows: [] } : owned(q),
    )
    await expect(saveObservationPage(db, H, empty, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      RunFencedError,
    )
    expect(seen.transactions).toBe(1)
  })
})
