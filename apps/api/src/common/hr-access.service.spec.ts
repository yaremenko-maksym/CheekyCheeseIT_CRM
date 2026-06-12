import { describe, expect, it, vi } from 'vitest'
import { HrAccessService } from './hr-access.service'

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
