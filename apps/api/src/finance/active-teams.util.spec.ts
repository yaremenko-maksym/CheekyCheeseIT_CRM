import { describe, it, expect, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { findActiveTeamsForUser } from './active-teams.util'

type Db = DatabaseService['db']

function makeDb(findMany: unknown): Db {
  return { query: { teamMembers: { findMany } } } as unknown as Db
}

const team = (id: string, over: number | null | undefined, archivedAt: Date | null = null) => ({
  team: { id, seniorSharePercentOverride: over, archivedAt },
})

describe('findActiveTeamsForUser', () => {
  it('returns active teams with their override', async () => {
    const findMany = vi.fn().mockResolvedValue([team('t1', 40), team('t2', 55)])
    const res = await findActiveTeamsForUser(makeDb(findMany), 'u1')
    expect(res).toEqual([
      { id: 't1', seniorSharePercentOverride: 40 },
      { id: 't2', seniorSharePercentOverride: 55 },
    ])
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toMatchObject({ with: { team: true } })
    expect(findMany.mock.calls[0][0].where).toBeDefined()
  })

  it('filters out archived teams', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([team('t1', 40, new Date('2026-01-01')), team('t2', 10)])
    expect(await findActiveTeamsForUser(makeDb(findMany), 'u1')).toEqual([
      { id: 't2', seniorSharePercentOverride: 10 },
    ])
  })

  it('maps missing override to null and keeps an explicit zero', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([team('t1', undefined), team('t2', null), team('t3', 0)])
    expect(await findActiveTeamsForUser(makeDb(findMany), 'u1')).toEqual([
      { id: 't1', seniorSharePercentOverride: null },
      { id: 't2', seniorSharePercentOverride: null },
      { id: 't3', seniorSharePercentOverride: 0 },
    ])
  })

  it('drops rows whose team relation is missing', async () => {
    const findMany = vi.fn().mockResolvedValue([{ team: null }, team('t1', 5)])
    expect(await findActiveTeamsForUser(makeDb(findMany), 'u1')).toEqual([
      { id: 't1', seniorSharePercentOverride: 5 },
    ])
  })

  it('returns [] when the mock lacks findMany (catch fallback)', async () => {
    const db = { query: { teamMembers: {} } } as unknown as Db
    expect(await findActiveTeamsForUser(db, 'u1')).toEqual([])
  })

  it('returns [] when findMany rejects', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await findActiveTeamsForUser(makeDb(findMany), 'u1')).toEqual([])
  })

  it('returns [] when there are no memberships', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    expect(await findActiveTeamsForUser(makeDb(findMany), 'u1')).toEqual([])
  })
})
