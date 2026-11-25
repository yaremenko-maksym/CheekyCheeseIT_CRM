import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { coverageOf } from '../ownership/job-run-ledger'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  RUN_ABSENT_REASON_PREFIX,
  type RunAbsenceInput,
  enqueueRunAbsentRecords,
  markListedPresent,
} from './run-absence-producer'

/**
 * Backlog 470 — the pure gates of the absence producer: which endings may enqueue anything at all,
 * and what each statement is bound to. The SQL itself runs in `job-run-ledger.coverage.integration`.
 */
const dialect = new PgDialect()

/**
 * An executor that records each statement and answers with `rowsPer[i]` rows. The namespace reads
 * of `markListedPresent` go to `resolved` instead and answer every key, in `nsOf(key)`.
 */
function recorder(rowsPer: number[] = [], nsOf: (key: string) => string = () => 'ns') {
  const sent: { sql: string; params: unknown[] }[] = []
  const resolved: { sql: string; params: unknown[] }[] = []
  const tx = {
    async execute(q: SQL) {
      const { sql, params } = dialect.sqlToQuery(q)
      if (sql.startsWith('SELECT r.namespace, r.identity_key')) {
        resolved.push({ sql, params })
        const keys = JSON.parse(String(params[1])) as string[]
        return { rows: keys.map((k) => ({ namespace: nsOf(k), identity_key: k })) }
      }
      sent.push({ sql, params })
      const n = rowsPer[sent.length - 1] ?? 0
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}` })) }
    },
  } as unknown as SqlExecutor
  return { tx, sent, resolved }
}

/** The (namespace, identity key) pairs one lock statement was bound to. */
const pairsOf = (s: { params: unknown[] }) => JSON.parse(String(s.params[1])) as string[][]

const ENDED = new Date('2026-11-20T12:00:00Z')
const input = (over: Partial<RunAbsenceInput> = {}): RunAbsenceInput => ({
  runId: 'run-1',
  sourceId: 'src-1',
  sourceType: 'REMOTIVE_API',
  cycleId: null,
  outcome: 'SUCCEEDED',
  coverage: 'FULL_INVENTORY',
  endedAt: ENDED,
  ...over,
})

describe('coverageOf: only a SUCCEEDED ending may claim an inventory', () => {
  it.each([
    ['SUCCEEDED', 'FULL_INVENTORY', 'FULL_INVENTORY'],
    ['SUCCEEDED', 'WINDOW', 'WINDOW'],
    ['SUCCEEDED', undefined, 'PARTIAL'],
    ['FAILED', 'FULL_INVENTORY', 'PARTIAL'],
    ['PARTIAL', 'FULL_INVENTORY', 'PARTIAL'],
    ['CANCELLED', 'WINDOW', 'PARTIAL'],
  ] as const)('%s with %s is stored as %s', (outcome, coverage, stored) => {
    expect(coverageOf({ outcome, ...(coverage !== undefined && { coverage }) })).toBe(stored)
  })
})

describe('enqueueRunAbsentRecords', () => {
  it.each([
    ['a FAILED run', input({ outcome: 'FAILED' })],
    ['a PARTIAL outcome', input({ outcome: 'PARTIAL' })],
    ['a CANCELLED run', input({ outcome: 'CANCELLED', coverage: 'WINDOW' })],
    ['a SUCCEEDED run with PARTIAL coverage', input({ coverage: 'PARTIAL' })],
  ])('%s sends no statement and enqueues nothing', async (_label, i) => {
    const { tx, sent } = recorder([5])
    expect(await enqueueRunAbsentRecords(tx, i)).toBe(0)
    expect(sent).toEqual([])
  })

  it('a FULL_INVENTORY run enqueues every unseen record not CLOSED, under its own reason', async () => {
    const { tx, sent } = recorder([2])
    expect(await enqueueRunAbsentRecords(tx, input({ cycleId: 'cyc-1' }))).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).toEqual(
      expect.arrayContaining([`${RUN_ABSENT_REASON_PREFIX}run-1`, 'cyc-1', 'src-1', 'run-1']),
    )
    expect(sent[0]!.sql).toContain(`r.availability <> 'CLOSED'`)
    expect(sent[0]!.sql).not.toContain('last_observed_at')
    // Bounded per run, and a record already waiting on an absence row is not queued again.
    expect(sent[0]!.params).toContain(1000)
    expect(sent[0]!.sql).toContain(`w.status = 'PENDING'`)
    expect(sent[0]!.params).toContain(RUN_ABSENT_REASON_PREFIX)
  })

  it('a WINDOW run enqueues only records last seen before ended_at minus the source window', async () => {
    const { tx, sent } = recorder([1])
    expect(await enqueueRunAbsentRecords(tx, input({ coverage: 'WINDOW' }))).toBe(1)
    // REMOTIVE_API: the 3-day default window.
    expect(sent[0]!.params).toContain('2026-11-17T12:00:00.000Z')
    expect(sent[0]!.sql).toContain(`r.availability NOT IN ('CLOSED', 'EXPIRED')`)
    expect(sent[0]!.sql).toContain('r.last_observed_at <')
    // No known feed depth: no reach filter, nothing at all after the received check.
    expect(sent[0]!.sql).not.toContain('published_at')
    expect(sent[0]!.sql).toMatch(/cr\.received > 0\)\s+AND NOT EXISTS/)
  })

  it('CR-M-3: a WINDOW type with a feed depth skips postings older than ended_at minus it', async () => {
    const { tx, sent } = recorder([0])
    await enqueueRunAbsentRecords(tx, input({ coverage: 'WINDOW', sourceType: 'THEIRSTACK_API' }))
    // TheirStack: a 21-day expiry window and a 7-day feed depth.
    expect(sent[0]!.params).toContain('2026-10-30T12:00:00.000Z')
    expect(sent[0]!.params).toContain('2026-11-13T12:00:00.000Z')
    expect(sent[0]!.sql).toContain('coalesce((SELECT rv.published_at')
  })

  it('SR-M-2: re-arms a finished absence row before inserting a new one', async () => {
    const { tx, sent } = recorder([3])
    expect(await enqueueRunAbsentRecords(tx, input())).toBe(3)
    expect(sent[0]!.sql).toContain(`d.status = 'DONE'`)
    expect(sent[0]!.sql).toContain('WHERE p.id NOT IN (SELECT entity_id FROM rearmed)')
  })
})

describe('markListedPresent', () => {
  const mark = (tx: SqlExecutor, held: string[], quarantined: string[]) =>
    markListedPresent(tx, {
      runId: 'run-1',
      sourceId: 'src-1',
      cycleId: null,
      present: { held, quarantined },
    })

  it('nothing listed: no statement, nothing counted', async () => {
    const { tx, sent } = recorder()
    expect(await mark(tx, [], [])).toBe(0)
    expect(sent).toEqual([])
  })

  it('counts only the held postings it marked; a quarantined one is marked, not counted, never reopened', async () => {
    // One lock over every key, then the marks. Held mark -> 2 rows and its relisted insert;
    // quarantined mark -> 1 row and NO relisted insert.
    const { tx, sent } = recorder([0, 2, 0, 1])
    expect(await mark(tx, ['["h1"]', '["h2"]'], ['["q1"]'])).toBe(2)
    expect(sent).toHaveLength(4)
    expect(sent[1]!.params).toContain(JSON.stringify(['["h1"]', '["h2"]']))
    expect(sent[2]!.params).toContain('RECORD_RELISTED:run-1')
    // The reopen is asked for exactly the records the mark returned.
    expect(sent[2]!.params).toContain(JSON.stringify(['r0', 'r1']))
    expect(sent[3]!.params).toContain(JSON.stringify(['["q1"]']))
  })

  it('splits a long quarantined listing into statements of 1000 keys too', async () => {
    const quarantined = Array.from({ length: 1001 }, (_, i) => `["q${String(i).padStart(4, '0')}"]`)
    // Two locks, then two marks.
    const { tx, sent } = recorder([0, 0, 1000, 1])
    expect(await mark(tx, [], quarantined)).toBe(0)
    expect(sent).toHaveLength(4)
    expect(sent[2]!.params).toContain(JSON.stringify(quarantined.slice(0, 1000)))
    expect(sent[3]!.params).toContain(JSON.stringify(['["q1000"]']))
  })

  it('splits a long listing into statements of 1000 keys', async () => {
    const held = Array.from({ length: 1001 }, (_, i) => `["h${String(i).padStart(4, '0')}"]`)
    // Two locks; per chunk the mark and its relisted insert.
    const { tx, sent } = recorder([0, 0, 1000, 0, 1, 0])
    expect(await mark(tx, held, [])).toBe(1001)
    expect(sent).toHaveLength(6)
    expect(sent[2]!.params).toContain(JSON.stringify(held.slice(0, 1000)))
    expect(sent[4]!.params).toContain(JSON.stringify(['["h1000"]']))
  })

  it('marks nobody: no relisted statement follows', async () => {
    const { tx, sent } = recorder([0, 0])
    expect(await mark(tx, ['["gone"]'], [])).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it('CR-M-1: locks in the house order (namespace, identity key) before writing', async () => {
    const { tx, sent } = recorder([0, 0])
    await mark(tx, ['["b"]', '["a"]'], [])
    expect(sent[0]!.sql).toMatch(
      /ORDER BY r\.namespace COLLATE "C", r\.identity_key COLLATE "C"\s+FOR UPDATE$/,
    )
    expect(sent[0]!.params).toEqual([
      'src-1',
      JSON.stringify([
        ['ns', '["a"]'],
        ['ns', '["b"]'],
      ]),
    ])
  })

  it('exactly 1000 keys: one namespace read and one lock, no empty statement', async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `["e${String(i).padStart(4, '0')}"]`)
    const { tx, sent, resolved } = recorder()
    await mark(tx, keys, [])
    expect(resolved).toHaveLength(1)
    expect(sent.filter((s) => /FOR UPDATE$/.test(s.sql))).toHaveLength(1)
  })

  it('R3-CR-M-1: two namespaces across a chunk boundary lock in (namespace, identity key) order', async () => {
    // 1000 keys in namespace "b" sort BEFORE the one key in namespace "a" by key alone; the house
    // order puts "a" first, so the first chunk must open with it.
    const inB = Array.from({ length: 1000 }, (_, i) => `["a${String(i).padStart(4, '0')}"]`)
    const inA = '["z"]'
    const { tx, sent, resolved } = recorder([], (k) => (k === inA ? 'a' : 'b'))
    await mark(tx, [...inB, inA], [])
    expect(resolved).toHaveLength(2)
    const locks = sent.filter((s) => /FOR UPDATE$/.test(s.sql))
    expect(locks).toHaveLength(2)
    expect(pairsOf(locks[0]!)[0]).toEqual(['a', '["z"]'])
    expect(pairsOf(locks[0]!)[1]).toEqual(['b', '["a0000"]'])
    expect(pairsOf(locks[1]!)).toEqual([['b', '["a0999"]']])
  })

  it('R3-CR-M-1: one global order across held, quarantined and chunks, each key locked once', async () => {
    // 1001 held keys and 2 quarantined ones interleaved by key, one key in both lists.
    const held = Array.from({ length: 1001 }, (_, i) => `["k${String(2 * i).padStart(4, '0')}"]`)
    const quarantined = ['["k0001"]', '["k0000"]']
    const { tx, sent } = recorder()
    await mark(tx, [...held].reverse(), quarantined)
    const locks = sent.filter((s) => /FOR UPDATE$/.test(s.sql))
    expect(locks).toHaveLength(2)
    const locked = locks.flatMap((s) => pairsOf(s).map(([, key]) => key))
    // The literal sequence: k0000, k0001, k0002, k0004, ..., k2000.
    const expected = ['["k0000"]', '["k0001"]', ...held.slice(1)]
    expect(locked).toEqual(expected)
    // Every lock precedes every mark.
    expect(sent.findIndex((s) => !/FOR UPDATE$/.test(s.sql))).toBe(2)
  })
})
