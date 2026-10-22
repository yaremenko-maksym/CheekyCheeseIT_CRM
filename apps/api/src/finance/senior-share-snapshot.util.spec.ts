import { describe, expect, it, vi } from 'vitest'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'
import type { DatabaseService } from '../database/database.service'

function dbWithTeams(overrides: Array<number | null>) {
  return {
    query: {
      teamMembers: {
        findMany: vi.fn().mockResolvedValue(
          overrides.map((o, i) => ({
            team: { id: `t${i}`, seniorSharePercentOverride: o, archivedAt: null },
          })),
        ),
      },
    },
  } as unknown as DatabaseService['db']
}

describe('resolveSeniorShareSnapshot', () => {
  it('prefers the project override', async () => {
    const r = await resolveSeniorShareSnapshot(
      dbWithTeams([30]),
      { seniorSharePercentOverride: 20 },
      { id: 's1', seniorSharePercent: 40 },
    )
    expect(r).toEqual({ value: 20, source: 'PROJECT' })
  })

  it('uses the single team override when no project override', async () => {
    const r = await resolveSeniorShareSnapshot(
      dbWithTeams([30]),
      { seniorSharePercentOverride: null },
      { id: 's1', seniorSharePercent: 40 },
    )
    expect(r).toEqual({ value: 30, source: 'TEAM' })
  })

  it('falls back to the user default with no overrides', async () => {
    const r = await resolveSeniorShareSnapshot(
      dbWithTeams([]),
      { seniorSharePercentOverride: undefined },
      { id: 's1', seniorSharePercent: 40 },
    )
    expect(r).toEqual({ value: 40, source: 'USER_DEFAULT' })
  })
})
