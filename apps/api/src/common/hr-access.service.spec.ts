import { describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getHrScope, HrAccessService, hrScopeCoversProject } from './hr-access.service'

// Minimal DatabaseService stub mirroring the chainable drizzle query builder
// used by HrAccessService (.select().from().where().limit() → Promise).
function makeChain() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  }
}

function makeDbStub() {
  const chain = makeChain()
  return { db: { select: vi.fn(() => chain) }, _chain: chain }
}

function build() {
  const stub = makeDbStub()
  const service = new HrAccessService(stub as never)
  return { service, chain: stub._chain }
}

const HR_ID = '00000000-0000-4000-a000-000000000001'
const USER_ID = '00000000-0000-4000-a000-000000000002'

describe('HrAccessService.hrSharesActiveTeamWith', () => {
  it('returns true when HR and user share an active team', async () => {
    const { service, chain } = build()
    chain.limit
      .mockResolvedValueOnce([{ teamId: 'team-1' }]) // HR active teams
      .mockResolvedValueOnce([{ id: 'tm-1' }]) // user active in a shared team
    expect(await service.hrSharesActiveTeamWith(HR_ID, USER_ID)).toBe(true)
  })

  it('returns false when the user is in no shared team', async () => {
    const { service, chain } = build()
    chain.limit
      .mockResolvedValueOnce([{ teamId: 'team-1' }]) // HR active teams
      .mockResolvedValueOnce([]) // user not in any shared team
    expect(await service.hrSharesActiveTeamWith(HR_ID, USER_ID)).toBe(false)
  })

  it('returns false (short-circuits) when HR has no active teams', async () => {
    const { service, chain } = build()
    chain.limit.mockResolvedValueOnce([]) // HR has no active teams
    const result = await service.hrSharesActiveTeamWith(HR_ID, USER_ID)
    expect(result).toBe(false)
    // Only the first query runs — the second is skipped (no teamIds to match).
    expect(chain.limit).toHaveBeenCalledTimes(1)
  })
})

describe('getHrScope — team member query', () => {
  it('filters the team members to the SENIOR and DROP roles', async () => {
    const where = vi
      .fn()
      .mockResolvedValueOnce([{ teamId: 'team-1' }])
      .mockResolvedValueOnce([])
    const chain = { from: () => chain, innerJoin: () => chain, where }
    const db = { db: { select: () => chain } }
    await getHrScope(db as never, HR_ID)
    const params = new PgDialect().sqlToQuery(where.mock.calls[1]![0] as SQL).params
    expect(params).toEqual(['team-1', 'SENIOR', 'DROP'])
  })
})

describe('hrScopeCoversProject', () => {
  const scope = { seniorIds: ['s-1', 's-2'], dropIds: ['d-1', 'd-2'] }
  it.each([
    ['a scoped senior', { seniorId: 's-2', dropId: null }, true],
    ['a scoped drop', { seniorId: 'x', dropId: 'd-2' }, true],
    ['neither in scope', { seniorId: 'x', dropId: 'y' }, false],
    ['no senior and no drop', { seniorId: null, dropId: null }, false],
  ])('%s → %s', (_l, project, expected) => {
    expect(hrScopeCoversProject(scope, project)).toBe(expected)
  })

  it('an empty scope covers nothing', () => {
    expect(
      hrScopeCoversProject({ seniorIds: [], dropIds: [] }, { seniorId: 's-1', dropId: 'd-1' }),
    ).toBe(false)
  })
})
