import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { JobRunLedger } from './job-run-ledger'

/**
 * r5 Task 2.5 T5 — `closeCycle`, `countDue` and the `onlyIds` / `onlyTypes` scope, over a database
 * double that records the SQL it is handed (the mutation gate runs no integration spec, so the
 * statements are pinned here; `job-run-ledger.window.integration.spec.ts` runs them on Postgres).
 */
const dialect = new PgDialect()
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

function ledgerOver(rows: Record<string, unknown>[]) {
  const execute = vi.fn(async (_q: SQL) => ({ rows }))
  const ledger = new JobRunLedger({ execute } as never, {} as never, {} as never)
  const last = () => dialect.sqlToQuery(execute.mock.calls.at(-1)![0])
  return { ledger, execute, last }
}

describe('closeCycle', () => {
  it('closes an OPEN cycle: the statement, the id as a parameter, true when one row changed', async () => {
    const { ledger, last } = ledgerOver([{ id: ID }])
    expect(await ledger.closeCycle(ID)).toBe(true)
    expect(last().sql).toBe(
      `UPDATE job_collection_cycles SET status = 'CLOSED', closed_at = clock_timestamp()
           WHERE id = $1::uuid AND status = 'OPEN' RETURNING id`,
    )
    expect(last().params).toEqual([ID])
  })

  it('false when nothing changed (already closed, or no such cycle); never more than one row is true', async () => {
    expect(await ledgerOver([]).ledger.closeCycle(ID)).toBe(false)
    expect(await ledgerOver([{ id: 1 }, { id: 2 }]).ledger.closeCycle(ID)).toBe(false)
  })

  it('refuses an id that is not a uuid before it reaches the database', async () => {
    const { ledger, execute } = ledgerOver([])
    await expect(ledger.closeCycle('1; DROP TABLE job_collection_cycles')).rejects.toThrow(
      'invalid cycle id',
    )
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('countDue, the sweep scope (U3)', () => {
  const CYCLE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
  const interval = { intervalMinutes: 60, offIntervalMinutes: null, window: null }
  const catalog = {
    entry: (id: string) =>
      ({
        'm.interval': { fetchProfile: interval },
        'm"q\\b': { fetchProfile: interval },
        'm.fixed': {
          fetchProfile: {
            ...interval,
            fixedSlots: { timeZone: 'Europe/Kyiv', times: ['08:00'] },
          },
        },
        'm.null': { fetchProfile: null },
      })[id],
    hostPolicy: () => undefined,
  }

  it('counts with the sweep predicate, over the sweepable manifest ids only, minus the skipped sources', async () => {
    const execute = vi.fn(async (q: SQL) =>
      dialect.sqlToQuery(q).sql.includes('DISTINCT manifest_id')
        ? {
            rows: [
              { manifest_id: 'm.interval' },
              { manifest_id: 'm"q\\b' },
              { manifest_id: 'm.fixed' },
              { manifest_id: 'm.null' },
              { manifest_id: 'm.unknown' },
              { manifest_id: null },
            ],
          }
        : { rows: [{ n: 4 }] },
    )
    const ledger = new JobRunLedger({ execute } as never, {} as never, catalog as never)
    expect(await ledger.countDue({ sweep: { cycleId: CYCLE, skipIds: [ID] } })).toBe(4)
    expect(execute).toHaveBeenCalledTimes(2)
    const first = dialect.sqlToQuery(execute.mock.calls[0]![0])
    expect(first.sql).toBe(
      'SELECT DISTINCT manifest_id FROM job_sources WHERE manifest_id IS NOT NULL',
    )
    const count = dialect.sqlToQuery(execute.mock.calls[1]![0])
    expect(count.sql).not.toContain('<= clock_timestamp() +')
    expect(count.sql).toContain('sr.cycle_id = $')
    expect(count.sql).toMatch(/job_sources\.manifest_id = ANY\(\$\d+::text\[\]\)/)
    expect(count.sql).toMatch(/NOT \(job_sources\.id = ANY\(\$\d+::uuid\[\]\)\)/)
    // only the two interval entries, each quoted, the quote and the backslash escaped
    expect(count.params).toContain('{"m.interval","m\\"q\\\\b"}')
    expect(count.params).toContain(`{${ID}}`)
    expect(count.params).toContain(CYCLE)
  })

  it('without a sweep it never reads the manifest ids', async () => {
    const execute = vi.fn(async (_q: SQL) => ({ rows: [{ n: 1 }] }))
    const ledger = new JobRunLedger({ execute } as never, {} as never, catalog as never)
    await ledger.countDue({})
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('countDue', () => {
  it('counts the sources the scheduled due predicate admits, narrowed by nothing by default', async () => {
    const { ledger, last } = ledgerOver([{ n: 7 }])
    expect(await ledger.countDue({})).toBe(7)
    expect(last().sql).toMatch(/^SELECT count\(\*\)::int AS n FROM job_sources\s+WHERE \(/)
    expect(last().sql).toMatch(/\)\s+AND true AND true$/)
    expect(last().sql).not.toContain('ANY(')
  })

  it('asks the SCHEDULED due predicate, at the ledger`s own failure cap', async () => {
    const execute = vi.fn(async (_q: SQL) => ({ rows: [{ n: 0 }] }))
    const ledger = new JobRunLedger({ execute } as never, {} as never, {} as never, {
      maxConsecutiveFailures: 5,
    })
    await ledger.countDue({})
    const { params } = dialect.sqlToQuery(execute.mock.calls[0]![0])
    expect(params).toContain('SCHEDULED') // the trigger-mode term; a manual trigger drops the cadence term
    expect(params).toContain(5) // consecutive_failures < the cap this ledger was built with
    expect(params).not.toContain(3)
  })

  it('looks ahead by lookaheadMs, floored, never negative, and never past the 10-minute limit', async () => {
    const slackOf = async (lookaheadMs?: number) => {
      const { ledger, last } = ledgerOver([{ n: 0 }])
      await ledger.countDue(lookaheadMs === undefined ? {} : { lookaheadMs })
      return last().params.filter((p) => typeof p === 'number' && p >= 0 && p !== 3)
    }
    expect(await slackOf()).toEqual([0])
    expect(await slackOf(2_500.9)).toEqual([2_500])
    expect(await slackOf(-5)).toEqual([0])
    expect(await slackOf(60 * 60_000)).toEqual([600_000]) // MAX_EARLY_DUE_SLACK_MS
  })

  it('no row, or a null count, is zero', async () => {
    expect(await ledgerOver([]).ledger.countDue({})).toBe(0)
    expect(await ledgerOver([{ n: null }]).ledger.countDue({})).toBe(0)
  })

  it('narrows to the ids and the types it is given, as bound parameters', async () => {
    const { ledger, last } = ledgerOver([{ n: 2 }])
    await ledger.countDue({ onlyIds: [ID], onlyTypes: ['JUSTJOIN_HTML', 'DICE_HTML'] })
    expect(last().sql).toMatch(
      /AND job_sources\.id = ANY\(\$\d+::uuid\[\]\) AND job_sources\.type::text = ANY\(\$\d+::text\[\]\)$/,
    )
    expect(last().params).toContain(`{${ID}}`)
    expect(last().params).toContain('{JUSTJOIN_HTML,DICE_HTML}')
  })

  it('narrows by ids alone and by types alone', async () => {
    const ids = ledgerOver([{ n: 1 }])
    await ids.ledger.countDue({ onlyIds: [ID] })
    expect(ids.last().sql).toMatch(/AND job_sources\.id = ANY\(\$\d+::uuid\[\]\) AND true$/)
    const types = ledgerOver([{ n: 1 }])
    await types.ledger.countDue({ onlyTypes: ['DICE_HTML'] })
    expect(types.last().sql).toMatch(
      /AND true AND job_sources\.type::text = ANY\(\$\d+::text\[\]\)$/,
    )
  })

  it('an id that is not a uuid is refused; a type that is not a type name is refused', async () => {
    const { ledger, execute } = ledgerOver([{ n: 0 }])
    await expect(ledger.countDue({ onlyIds: ['x'] })).rejects.toThrow('not a uuid')
    for (const bad of ['', 'a', '1X', 'X;', 'X Y', "X'", `A${'B'.repeat(64)}`]) {
      await expect(ledger.countDue({ onlyTypes: [bad as never] })).rejects.toThrow('not a type')
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('accepts the shortest and the longest well-formed type names', async () => {
    const { ledger, last } = ledgerOver([{ n: 0 }])
    await ledger.countDue({ onlyTypes: ['A', `A${'B'.repeat(63)}`, 'A_1'] })
    expect(last().params).toContain(`{A,A${'B'.repeat(63)},A_1}`)
  })
})
