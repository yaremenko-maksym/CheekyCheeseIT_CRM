import { describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { ProjectReadService } from './project-read.service'
import type { ProjectWithRelations } from './project-map.util'

type TeamRow = {
  userId: string
  team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null } | null
}

function build(findMany: (arg: unknown) => Promise<TeamRow[]> = async () => []) {
  const findManySpy = vi.fn(findMany)
  const db = { db: { query: { teamMembers: { findMany: findManySpy } } } }
  const approvals = { getStatus: vi.fn(async () => 'PENDING' as string) }
  const access = { assertAccess: vi.fn(async () => undefined) }
  const service = new ProjectReadService(db as never, access as never, approvals as never)
  return { service, findMany: findManySpy, approvals, access }
}

const proj = (seniorId: string | null | undefined) => ({ seniorId }) as ProjectWithRelations

describe('ProjectReadService.loadTeamOverridesBySenior', () => {
  it('does not query at all when no project references a senior', async () => {
    const h = build()
    const map = await h.service.loadTeamOverridesBySenior([proj(null), proj(undefined), proj('')])
    expect(map.size).toBe(0)
    expect(h.findMany).not.toHaveBeenCalled()
  })

  it('does not query for an empty project list', async () => {
    const h = build()
    await h.service.loadTeamOverridesBySenior([])
    expect(h.findMany).not.toHaveBeenCalled()
  })

  it('queries once with the de-duplicated, non-empty senior ids only', async () => {
    const h = build()
    await h.service.loadTeamOverridesBySenior([
      proj('s1'),
      proj('s1'),
      proj(null),
      proj(''),
      proj('s2'),
    ])
    expect(h.findMany).toHaveBeenCalledTimes(1)
    const where = (h.findMany.mock.calls[0]![0] as { where: SQL }).where
    const { params } = new PgDialect().sqlToQuery(where)
    expect(params).toEqual(['s1', 's2'])
  })

  it('groups active, non-archived teams per senior, keeping a null override as null', async () => {
    const h = build(async () => [
      { userId: 's1', team: { id: 't1', seniorSharePercentOverride: 30, archivedAt: null } },
      { userId: 's1', team: { id: 't2', seniorSharePercentOverride: null, archivedAt: null } },
      { userId: 's2', team: { id: 't3', seniorSharePercentOverride: 35, archivedAt: null } },
    ])
    const map = await h.service.loadTeamOverridesBySenior([proj('s1'), proj('s2')])
    expect(map.get('s1')).toEqual([
      { id: 't1', seniorSharePercentOverride: 30 },
      { id: 't2', seniorSharePercentOverride: null },
    ])
    expect(map.get('s2')).toEqual([{ id: 't3', seniorSharePercentOverride: 35 }])
  })

  it('skips memberships whose team is missing or archived', async () => {
    const h = build(async () => [
      { userId: 's1', team: null },
      {
        userId: 's1',
        team: { id: 'old', seniorSharePercentOverride: 10, archivedAt: new Date('2026-01-01') },
      },
      { userId: 's2', team: { id: 't3', seniorSharePercentOverride: 35, archivedAt: null } },
    ])
    const map = await h.service.loadTeamOverridesBySenior([proj('s1'), proj('s2')])
    expect(map.has('s1')).toBe(false)
    expect(map.get('s2')).toEqual([{ id: 't3', seniorSharePercentOverride: 35 }])
  })

  it('falls back to "no overrides" when the query itself throws', async () => {
    const h = build(async () => {
      throw new Error('no such table')
    })
    const map = await h.service.loadTeamOverridesBySenior([proj('s1')])
    expect(map.size).toBe(0)
  })
})

describe('ProjectReadService.loadPendingSeniorShare', () => {
  const senior = { id: 's1', displayName: 'Senior One', seniorSharePercent: 40 }

  it('returns null without asking approvals when there is no senior', async () => {
    const h = build()
    expect(await h.service.loadPendingSeniorShare('p1', null, 30, new Map())).toBeNull()
    expect(await h.service.loadPendingSeniorShare('p1', undefined, 30, new Map())).toBeNull()
    expect(h.approvals.getStatus).not.toHaveBeenCalled()
  })

  it('asks the senior-share subject type and returns null unless PENDING', async () => {
    const h = build()
    h.approvals.getStatus.mockResolvedValueOnce('NONE')
    expect(await h.service.loadPendingSeniorShare('p1', senior, 30, new Map())).toBeNull()
    expect(h.approvals.getStatus).toHaveBeenCalledWith('PROJECT_SENIOR_SHARE', 'p1')
  })

  it('builds the DTO when PENDING, including a cleared (null) proposal', async () => {
    const h = build()
    expect(await h.service.loadPendingSeniorShare('p1', senior, 30, new Map())).toEqual({
      percent: 30,
      effectivePercentAfterApproval: 30,
      approverId: 's1',
      approverName: 'Senior One',
    })
    const cleared = await h.service.loadPendingSeniorShare('p1', senior, null, new Map())
    expect(cleared?.percent).toBeNull()
  })
})
