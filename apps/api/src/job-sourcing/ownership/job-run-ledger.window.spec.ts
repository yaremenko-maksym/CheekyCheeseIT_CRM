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
