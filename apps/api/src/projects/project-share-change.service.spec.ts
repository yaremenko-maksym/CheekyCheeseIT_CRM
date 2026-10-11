import { describe, expect, it, vi } from 'vitest'
import { ProjectShareChangeService } from './project-share-change.service'

// Unit doubles for the project_finance_settings mirror write. The pending-share
// specs drive the propose/approve/reject/cancel paths through ProjectsService;
// this file pins the upsert itself (update vs insert branch and their values).
function buildDb(existing: unknown) {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  const values = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn().mockReturnValue({ values })
  const findFirst = vi.fn().mockResolvedValue(existing)
  const db = { query: { projectFinanceSettings: { findFirst } }, update, insert }
  return { db, findFirst, update, set, where, insert, values }
}

function buildService(db: unknown) {
  return new ProjectShareChangeService(
    { db } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

describe('ProjectShareChangeService.syncFinanceSettingsOverride', () => {
  it('looks the row up by project id', async () => {
    const h = buildDb({ projectId: 'p1' })
    await buildService(h.db).syncFinanceSettingsOverride('p1', 30, 'actor-1')
    expect(h.findFirst).toHaveBeenCalledTimes(1)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }))
  })

  it('updates the existing row with the override, actor and a fresh timestamp', async () => {
    const h = buildDb({ projectId: 'p1' })
    const before = Date.now()
    await buildService(h.db).syncFinanceSettingsOverride('p1', 30, 'actor-1')
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.update).toHaveBeenCalledTimes(1)
    const setArg = h.set.mock.calls[0]![0] as {
      seniorSharePercentOverride: number | null
      updatedBy: string
      updatedAt: Date
    }
    expect(setArg.seniorSharePercentOverride).toBe(30)
    expect(setArg.updatedBy).toBe('actor-1')
    expect(setArg.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(h.where).toHaveBeenCalledWith(expect.anything())
  })

  it('writes a cleared override (null) through the update branch', async () => {
    const h = buildDb({ projectId: 'p1' })
    await buildService(h.db).syncFinanceSettingsOverride('p1', null, 'actor-1')
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({ seniorSharePercentOverride: null, updatedBy: 'actor-1' }),
    )
  })

  it('inserts a row with a null junior-salary override when none exists', async () => {
    const h = buildDb(undefined)
    await buildService(h.db).syncFinanceSettingsOverride('p1', 45, 'actor-2')
    expect(h.update).not.toHaveBeenCalled()
    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(h.values).toHaveBeenCalledWith({
      projectId: 'p1',
      seniorSharePercentOverride: 45,
      juniorSalaryOverride: null,
      updatedBy: 'actor-2',
    })
  })

  it('uses a caller-supplied handle instead of the pool when given one', async () => {
    const pool = buildDb(undefined)
    const tx = buildDb({ projectId: 'p1' })
    await buildService(pool.db).syncFinanceSettingsOverride('p1', 10, 'a', tx.db as never)
    expect(pool.findFirst).not.toHaveBeenCalled()
    expect(tx.update).toHaveBeenCalledTimes(1)
  })
})
