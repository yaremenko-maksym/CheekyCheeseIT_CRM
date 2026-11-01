import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { RECORD_REOPEN_REASON, reopenObservedRecord } from './record-reopen-updater'

const dialect = new PgDialect()
const REC = '0000000b-0000-4000-8000-000000000002'
const RUN = '0000000c-0000-4000-8000-000000000003'
const CYCLE = '0000000d-0000-4000-8000-000000000004'
const OPP = '0000000a-0000-4000-8000-000000000001'
const input = { sourceRecordId: REC, sourceId: 's', board: 'b', configVersion: 2 }
const runRow = {
  id: RUN,
  cycle_id: CYCLE,
  coverage: 'FULL_INVENTORY',
  observed_at: '2026-11-01T00:00:00Z',
}

/** Row-sets answered in order: lock, run select, reopen UPDATE, owners select, enqueues. */
function dbOf(...sets: Record<string, unknown>[][]) {
  const queue = [...sets]
  const statements: { sql: string; params: unknown[] }[] = []
  const execute = vi.fn(async (q: unknown) => {
    statements.push(dialect.sqlToQuery(q as SQL))
    return { rows: queue.shift() ?? [] }
  })
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) }
  return { db, statements }
}

describe('reopenObservedRecord (Task 4.6 S8f)', () => {
  it('pins the persisted dirty-work reason literal', () => {
    expect(RECORD_REOPEN_REASON).toBe('RECORD_REOPENED')
  })

  it('reads only a CLOSED/EXPIRED record listed by a SUCCEEDED run after it was checked', async () => {
    const { db, statements } = dbOf([{ id: REC }], [])
    expect(await reopenObservedRecord(db as never, input)).toEqual({ reopened: false })
    const select = statements[1]?.sql ?? ''
    expect(select).toContain(
      `rec.availability IN ('CLOSED'::job_availability, 'EXPIRED'::job_availability)`,
    )
    expect(select).toContain(`cr.outcome = 'SUCCEEDED'::job_collection_outcome`)
    expect(select).toContain('> coalesce(rec.availability_checked_at')
    expect(select).toContain('JOIN job_run_records jr')
    // SR-M-1: the START time, never the end time, is the observation basis.
    expect(select).toMatch(/AND cr\.started_at\s+> coalesce\(rec\.availability_checked_at/)
    expect(select).toContain('ORDER BY cr.started_at DESC')
    // No run listed it since it closed: nothing is written, nothing enqueued.
    expect(statements).toHaveLength(2)
  })

  it('reopens with OBSERVED_OPEN evidence from the newest run and enqueues each owner', async () => {
    const { db, statements } = dbOf(
      [{ id: REC }],
      [runRow],
      [{ id: REC }],
      [{ opportunity_id: OPP, revision: 4 }],
      [{ id: 'dirty' }],
    )
    expect(await reopenObservedRecord(db as never, input)).toEqual({ reopened: true })
    const update = statements[2]
    expect(update?.sql).toContain('UPDATE job_source_records')
    expect(JSON.parse(String(update?.params[0]))).toEqual({
      kind: 'OBSERVED_OPEN',
      basis: 'OBSERVED',
      runId: RUN,
      board: 'b',
      configVersion: 2,
      observedAt: '2026-11-01T00:00:00.000Z',
    })
    // The opportunity is enqueued at its CURRENT revision, with the run's cycle.
    expect(statements[4]?.params).toEqual(['OPPORTUNITY', OPP, 4, RECORD_REOPEN_REASON, CYCLE])
    expect(statements.some((s) => /job_opportunity_matches|job_suggestions/.test(s.sql))).toBe(
      false,
    )
  })

  it('a record the guard finds already OPEN is a no-op: no owner read, no enqueue', async () => {
    const { db, statements } = dbOf([{ id: REC }], [runRow], [])
    expect(await reopenObservedRecord(db as never, input)).toEqual({ reopened: false })
    expect(statements).toHaveLength(3)
  })

  it('a run without a cycle enqueues with a null cycle', async () => {
    const { db, statements } = dbOf(
      [{ id: REC }],
      [{ ...runRow, cycle_id: null }],
      [{ id: REC }],
      [{ opportunity_id: OPP, revision: 1 }],
      [{ id: 'dirty' }],
    )
    await reopenObservedRecord(db as never, input)
    expect(statements[4]?.params[4]).toBeNull()
  })

  it('refuses a record that does not belong to the source, before any other statement', async () => {
    const { db, statements } = dbOf([])
    await expect(reopenObservedRecord(db as never, input)).rejects.toThrow(/does not belong/)
    expect(statements).toHaveLength(1)
  })
})
