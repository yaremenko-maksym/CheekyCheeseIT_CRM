import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { nbuDailyRates } from '../database/schema'
import { NbuRateStore } from './nbu-rate-store'

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  inArray: vi.fn((column: unknown, values: unknown) => ({ column, values })),
}))

/**
 * Unit double for `NbuRateStore` (the integration spec checks the real table; the mutation gate
 * cannot see it, see `.claude/rules/common/mutation-gate-integration-specs.md`): the store maps
 * `YYYYMMDD` to the `date` column's ISO form and back, and writes once per day.
 */
function makeDb(rows: Array<Record<string, string>> = []) {
  const where = vi.fn(async () => rows)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  const onConflictDoNothing = vi.fn(async () => undefined)
  const values = vi.fn(() => ({ onConflictDoNothing }))
  const insert = vi.fn(() => ({ values }))
  const db = { db: { select, insert } } as unknown as DatabaseService
  return { db, select, from, where, insert, values, onConflictDoNothing }
}

describe('NbuRateStore', () => {
  it('asks for nothing when no day is requested', async () => {
    const m = makeDb()
    expect(await new NbuRateStore(m.db).findMany([])).toEqual(new Map())
    expect(m.select).not.toHaveBeenCalled()
  })

  it('queries the ISO dates of the requested days and keys the rows back by YYYYMMDD', async () => {
    const m = makeDb([
      { rateDate: '2026-11-10', usdUah: '41.1000', eurUah: '44.1000', sourceId: 'statdirectory' },
    ])
    const out = await new NbuRateStore(m.db).findMany(['20261110', '20261111'])
    expect(m.from).toHaveBeenCalledWith(nbuDailyRates)
    expect(m.where).toHaveBeenCalledWith({
      column: nbuDailyRates.rateDate,
      values: ['2026-11-10', '2026-11-11'],
    })
    expect([...out.entries()]).toEqual([
      [
        '20261110',
        { day: '20261110', usdUah: '41.1000', eurUah: '44.1000', sourceId: 'statdirectory' },
      ],
    ])
  })

  it('writes a day once, under its ISO date, keeping the first value on a conflict', async () => {
    const m = makeDb()
    await new NbuRateStore(m.db).save({
      day: '20261110',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'exchange_site',
    })
    expect(m.insert).toHaveBeenCalledWith(nbuDailyRates)
    expect(m.values).toHaveBeenCalledWith({
      rateDate: '2026-11-10',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'exchange_site',
    })
    expect(m.onConflictDoNothing).toHaveBeenCalledWith({ target: nbuDailyRates.rateDate })
  })
})
