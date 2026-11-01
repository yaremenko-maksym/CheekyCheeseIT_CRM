import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { identityObservations, specCheckpoint } from '../../test/ledger-fixtures'
import { observation } from '../../test/record-store-fixtures'
import type { MeterDb } from '../metering/account-meter.store'
import type { SourceObservation } from '../normalize/observation'
import { writePageProgress } from '../ownership/job-run-ledger'
import { RunFencedError } from '../ownership/run-ownership'
import { LockContentionError } from './lock-order'
import {
  MAX_OBSERVATIONS_PER_PAGE,
  expireRecordByWindow,
  type PageChunk,
  chunkPage,
  newestPublishedAt,
  saveObservation,
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

  it('an identity larger than the room left starts a new chunk; one exactly the cap fills one', () => {
    const page = {
      observations: identityObservations(['a', 'b', 'b', 'b', 'c'], 'n'),
      checkpoint: cp,
    }
    expect(chunkPage(page, 3).map(ids)).toEqual([['a'], ['b', 'b', 'b'], ['c']])
    const full = { observations: identityObservations(['x', 'x', 'y'], 'n'), checkpoint: cp }
    expect(chunkPage(full, 2).map(ids)).toEqual([['x', 'x'], ['y']])
  })

  it('CR-M-2: an identity larger than the cap is refused before any chunk exists', () => {
    const huge = { observations: identityObservations(['y', 'x', 'x', 'x'], 'n'), checkpoint: cp }
    expect(() => chunkPage(huge, 2)).toThrow(
      new RangeError('chunkPage: one identity has 3 observations, at most 2'),
    )
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

describe('the dirty-work producer (Task 4.6 S4a, AC 8)', () => {
  const RECORD = '00000000-0000-4000-8000-0000000000a1'
  const CYCLE = '00000000-0000-4000-8000-0000000000c1'
  /** A first observation: the record is new and its head is created at sequence 1. */
  const firstObservation = (cycle: string | null) => (q: Query) => {
    if (/SELECT cycle_id FROM job_collection_runs/.test(q.sql))
      return { rows: [{ cycle_id: cycle }] }
    if (/INSERT INTO job_source_records/.test(q.sql)) return { rows: [{ id: RECORD }] }
    if (/INSERT INTO job_source_record_revisions/.test(q.sql))
      return { rows: [{ id: '00000000-0000-4000-8000-0000000000b1', received_seq: 1 }] }
    if (/INSERT INTO job_source_record_heads/.test(q.sql)) return { rows: [{ observation_seq: 1 }] }
    if (/FROM job_source_record_heads/.test(q.sql)) return { rows: [] }
    return owned(q)
  }
  const page = {
    observations: [observation({ namespace: 'n', nativeId: 'a', tag: 's4a' })],
    checkpoint: specCheckpoint(1),
  }
  const enqueues = (statements: Query[]) =>
    statements.filter((s) => /INSERT INTO job_dirty_work/.test(s.sql))

  it('enqueues through the dirty-work store, in the page transaction, with the run cycle', async () => {
    const { db, seen } = recordingDb(firstObservation(CYCLE))
    await saveObservationPage(db, H, page)
    expect(seen.transactions).toBe(1)
    const [enqueue, ...more] = enqueues(seen.statements)
    expect(more).toEqual([])
    expect(enqueue?.sql).toMatch(
      /ON CONFLICT \(entity_kind, entity_id, target_version, reason\) DO NOTHING\s+RETURNING id/,
    )
    expect(enqueue?.params).toEqual(['SOURCE_RECORD', RECORD, 1, 'SOURCE_REVISION', CYCLE])
  })

  it('a run without a cycle enqueues with a null cycle', async () => {
    const { db, seen } = recordingDb(firstObservation(null))
    await saveObservationPage(db, H, page)
    expect(enqueues(seen.statements)[0]?.params).toEqual([
      'SOURCE_RECORD',
      RECORD,
      1,
      'SOURCE_REVISION',
      null,
    ])
  })

  it('content that does not move the pointer enqueues nothing', async () => {
    const REV = '00000000-0000-4000-8000-0000000000b1'
    const { db, seen } = recordingDb((q) => {
      if (/^\s*SELECT latest_revision_id/.test(q.sql))
        return { rows: [{ latest_revision_id: REV, not_older: true }] }
      if (/^\s*UPDATE job_source_record_heads/.test(q.sql))
        return { rows: [{ observation_seq: 3 }] }
      return firstObservation(CYCLE)(q)
    })
    await saveObservationPage(db, H, page)
    expect(seen.statements.some((s) => /UPDATE job_source_record_heads/.test(s.sql))).toBe(true)
    expect(enqueues(seen.statements)).toEqual([])
  })

  it('the single-observation write enqueues in the caller transaction too', async () => {
    const { db, seen } = recordingDb(firstObservation(CYCLE))
    await db.transaction((tx) => saveObservation(tx, H, page.observations[0] as SourceObservation))
    expect(enqueues(seen.statements)[0]?.params).toEqual([
      'SOURCE_RECORD',
      RECORD,
      1,
      'SOURCE_REVISION',
      CYCLE,
    ])
  })

  it('a run whose source row is gone writes nothing: the type check refuses the page', async () => {
    const noSource = (q: Query) =>
      /SELECT type FROM job_sources/.test(q.sql) ? { rows: [] } : firstObservation(CYCLE)(q)
    const single = recordingDb(noSource)
    await expect(
      single.db.transaction((tx) =>
        saveObservation(tx, H, page.observations[0] as SourceObservation),
      ),
    ).rejects.toThrow(new RangeError('saveObservations: an observation of another source type'))
    const paged = recordingDb(noSource)
    await expect(saveObservationPage(paged.db, H, page)).rejects.toThrow(
      new RangeError('saveObservations: an observation of another source type'),
    )
    expect(enqueues([...single.seen.statements, ...paged.seen.statements])).toEqual([])
  })
})

describe('newestPublishedAt (U2: savePage keeps the newest published_at seen)', () => {
  const at = (iso: string | null, n: number) => {
    const o = observation({ namespace: 'ns', nativeId: `n${n}`, tag: 't' })
    return {
      ...o,
      normalized: { ...o.normalized, publishedAt: iso === null ? null : new Date(iso) },
    }
  }

  it('is the newest of the page, wherever it sits', () => {
    const page = [
      at('2026-10-30T10:00:00Z', 1),
      at('2026-10-31T09:00:00Z', 2),
      at(null, 3),
      at('2026-10-29T00:00:00Z', 4),
    ]
    expect(newestPublishedAt(page)).toEqual(new Date('2026-10-31T09:00:00Z'))
  })

  it('is null for an empty page and for a page with no published_at', () => {
    expect(newestPublishedAt([])).toBeNull()
    expect(newestPublishedAt([at(null, 1), at(null, 2)])).toBeNull()
  })

  it('an equal later instant keeps the first (no change of value)', () => {
    const page = [at('2026-10-31T09:00:00Z', 1), at('2026-10-31T09:00:00Z', 2)]
    expect(newestPublishedAt(page)).toBe(page[0]!.normalized.publishedAt)
  })
})

describe('writePageProgress: the counters and the newest published_at (U2)', () => {
  const OWNED = { runId: H.runId, accountKey: 'a', sourceId: 's' }
  const write = async (newestPublishedAt: Date | null) => {
    const { db, seen } = recordingDb(owned)
    await db.transaction((tx) =>
      writePageProgress(tx as never, H, OWNED, {
        checkpoint: null,
        received: 7,
        unique: 5,
        created: 2,
        newestPublishedAt,
      }),
    )
    return seen.statements.at(-1)!
  }

  it('binds received, created, unchanged = unique - created, duplicates = received - unique', async () => {
    const update = await write(null)
    expect(update.params.slice(1, 5)).toEqual([7, 2, 3, 2])
  })

  it('keeps the newest published_at with GREATEST, the instant bound as ISO text', async () => {
    const at = new Date('2026-10-31T09:00:00.000Z')
    const update = await write(at)
    expect(update.sql).toMatch(
      /newest_item_published_at = GREATEST\(newest_item_published_at, \$6::timestamptz\)/,
    )
    expect(update.params[5]).toBe('2026-10-31T09:00:00.000Z')
    expect((await write(null)).params[5]).toBeNull()
  })
})

describe('expireRecordByWindow (Task 4.6 S8e, CR-M-3)', () => {
  const base = {
    runId: '00000000-0000-4000-8000-000000000001',
    board: 'b',
    configVersion: 1,
    observedAt: '2026-11-01T00:00:00.000Z',
  }

  it.each([
    ['OBSERVED_OPEN', { ...base, kind: 'OBSERVED_OPEN', basis: 'OBSERVED' }],
    ['DETAIL_GONE', { ...base, kind: 'DETAIL_GONE', httpStatus: 404, adapterVersion: 'v1' }],
  ])('rejects %s evidence and writes nothing', async (_k, evidence) => {
    const execute = vi.fn()
    await expect(
      expireRecordByWindow({ execute } as never, base.runId, evidence as never),
    ).rejects.toThrow(/only WINDOW_DROPPED/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('writes EXPIRED (never CLOSED) for WINDOW_DROPPED evidence', async () => {
    const execute = vi.fn(async (_q: unknown) => ({ rows: [{ id: 'r' }] }))
    const ok = await expireRecordByWindow({ execute } as never, base.runId, {
      ...base,
      kind: 'WINDOW_DROPPED',
    } as never)
    expect(ok).toBe(true)
    const text = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL).sql
    expect(text).toContain(`'EXPIRED'::job_availability`)
    expect(text).not.toContain(`SET availability = 'CLOSED'`)
  })
})
