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

/** An executor that records each statement and answers with `rowsPer[i]` rows. */
function recorder(rowsPer: number[] = []) {
  const sent: { sql: string; params: unknown[] }[] = []
  const tx = {
    async execute(q: SQL) {
      const { sql, params } = dialect.sqlToQuery(q)
      sent.push({ sql, params })
      const n = rowsPer[sent.length - 1] ?? 0
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}` })) }
    },
  } as unknown as SqlExecutor
  return { tx, sent }
}

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
    // held mark -> 2 rows, its relisted insert, quarantined mark -> 1 row and NO relisted insert.
    const { tx, sent } = recorder([2, 0, 1])
    expect(await mark(tx, ['["h1"]', '["h2"]'], ['["q1"]'])).toBe(2)
    expect(sent).toHaveLength(3)
    expect(sent[0]!.params).toContain(JSON.stringify(['["h1"]', '["h2"]']))
    expect(sent[1]!.params).toContain('RECORD_RELISTED:run-1')
    expect(sent[2]!.params).toContain(JSON.stringify(['["q1"]']))
  })

  it('splits a long listing into statements of 1000 keys', async () => {
    const held = Array.from({ length: 1001 }, (_, i) => `["h${i}"]`)
    const { tx, sent } = recorder([1000, 0, 1, 0])
    expect(await mark(tx, held, [])).toBe(1001)
    expect(sent).toHaveLength(4)
    expect(sent[0]!.params).toContain(JSON.stringify(held.slice(0, 1000)))
    expect(sent[2]!.params).toContain(JSON.stringify(['["h1000"]']))
  })

  it('marks nobody: no relisted statement follows', async () => {
    const { tx, sent } = recorder([0])
    expect(await mark(tx, ['["gone"]'], [])).toBe(0)
    expect(sent).toHaveLength(1)
  })
})
