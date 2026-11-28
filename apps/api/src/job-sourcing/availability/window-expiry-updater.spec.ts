import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { expireWindowRecord, readLatestWindowRun } from './window-expiry-updater'

/**
 * Backlog 470 outage guard, on a double: the expiry acts only from the D4 count of WINDOW misses.
 * Which runs count as a miss is SQL, pinned in `window-expiry-updater.integration.spec.ts`.
 */
const dialect = new PgDialect()
const RECORD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const SOURCE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const RUN = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const OBSERVED = '2026-11-20T12:00:00.000Z'
// Unseen for 10 days: far past the 3-day REMOTIVE_API window, so only the miss count decides.
const LAST_SEEN = '2026-11-10T12:00:00.000Z'

function dbWith(missedRuns: number) {
  const sent: string[] = []
  const params: unknown[][] = []
  const tx = {
    async execute(q: SQL) {
      const query = dialect.sqlToQuery(q)
      const text = query.sql
      sent.push(text)
      params.push(query.params)
      if (text.startsWith('SELECT r.id')) return { rows: [{ id: RECORD }] }
      if (text.startsWith('SELECT s.type'))
        return {
          rows: [
            {
              source_type: 'REMOTIVE_API',
              last_observed_at: LAST_SEEN,
              present: false,
              missed_runs: missedRuns,
            },
          ],
        }
      if (text.startsWith('UPDATE job_source_records')) return { rows: [{ id: RECORD }] }
      return { rows: [] }
    },
  }
  const db = { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as MeterDb
  return { db, sent, params }
}

const expire = (db: MeterDb) =>
  expireWindowRecord(
    db,
    { sourceRecordId: RECORD, sourceId: SOURCE, board: 'REMOTIVE_API:ns', configVersion: 1 },
    { runId: RUN, cycleId: null, observedAt: OBSERVED, baselineReceived: 40 },
  )

describe('R3-CR-M-3: the collapse baseline is read with the run, not per record', () => {
  it('the miss count takes the baseline as a parameter and never computes max(received)', async () => {
    const { db, sent, params } = dbWith(0)
    await expire(db)
    const i = sent.findIndex((s) => s.startsWith('SELECT s.type'))
    expect(sent[i]).not.toContain('max(')
    expect(params[i]).toContain(40)
    expect(params[i]).toContain(0.5)
  })

  it('readLatestWindowRun returns the baseline from the same statement', async () => {
    const sent: string[] = []
    const db = {
      async execute(q: SQL) {
        sent.push(dialect.sqlToQuery(q).sql)
        return {
          rows: [
            {
              id: RUN,
              cycle_id: null,
              coverage: 'WINDOW',
              observed_at: OBSERVED,
              baseline_received: 12,
            },
          ],
        }
      },
    } as unknown as SqlExecutor
    const run = await readLatestWindowRun(db, { sourceId: SOURCE, configVersion: 1 })
    expect(run).toEqual({
      runId: RUN,
      cycleId: null,
      observedAt: OBSERVED,
      baselineReceived: 12,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('max(b.received)')
  })
})

describe('expireWindowRecord: the miss count gate', () => {
  it('two misses are not enough: nothing is written', async () => {
    const { db, sent } = dbWith(2)
    expect(await expire(db)).toEqual({ expired: false })
    expect(sent.some((s) => s.startsWith('UPDATE job_source_records'))).toBe(false)
  })

  it('three misses past the window expire the record', async () => {
    const { db, sent } = dbWith(3)
    expect(await expire(db)).toEqual({ expired: true })
    expect(sent.some((s) => s.startsWith('UPDATE job_source_records'))).toBe(true)
  })
})
